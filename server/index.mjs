import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import express from "express";

const port = Number(process.env.PORT || 3000);
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const indexFile = fileURLToPath(new URL("../web/dist/index.html", import.meta.url));
const storageToken = process.env.STORAGE_API_TOKEN || "";
const storageConfig = {
    endpoint: process.env.S3_ENDPOINT || "",
    region: process.env.S3_REGION || "rainyun",
    bucket: process.env.S3_BUCKET || "",
    accessKeyId: process.env.S3_ACCESS_KEY || "",
    secretAccessKey: process.env.S3_SECRET_KEY || "",
};
const storageConfigured = Boolean(storageToken && Object.values(storageConfig).every(Boolean));
const reapiInputMaxBytes = 20 * 1024 * 1024;
const reapiInputUrlTtlSeconds = 15 * 60;
const reapiInputMimeExtensions = new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
]);
const s3 = storageConfigured
    ? new S3Client({
          endpoint: storageConfig.endpoint,
          region: storageConfig.region,
          forcePathStyle: true,
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
          credentials: {
              accessKeyId: storageConfig.accessKeyId,
              secretAccessKey: storageConfig.secretAccessKey,
          },
      })
    : null;

const app = express();

app.get("/healthz", (_request, response) => {
    response.json({ ok: true, storageConfigured });
});

app.use("/api/reapi-inputs", async (request, response) => {
    setCorsHeaders(request, response);
    if (request.method === "OPTIONS") return response.sendStatus(204);
    if (!storageConfigured || !s3) return response.status(503).send("Object storage is not configured");
    if (!isAuthorized(request.headers.authorization, storageToken)) {
        response.setHeader("WWW-Authenticate", 'Basic realm="infinite-canvas-storage"');
        return response.status(401).send("Unauthorized");
    }

    try {
        if (request.method === "POST" && request.path === "/") {
            const mimeType = String(request.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
            const extension = reapiInputMimeExtensions.get(mimeType);
            const length = contentLength(request.headers["content-length"]);
            if (!extension) return response.status(415).send("Only JPEG, PNG, WebP, and GIF images are supported");
            if (!length) return response.status(411).send("Content-Length is required");
            if (length > reapiInputMaxBytes) return response.status(413).send("Image is too large");

            const objectName = `${randomUUID()}.${extension}`;
            const key = `reapi-inputs/${objectName}`;
            await s3.send(new PutObjectCommand({ Bucket: storageConfig.bucket, Key: key, Body: request, ContentLength: length, ContentType: mimeType }));
            const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: storageConfig.bucket, Key: key }), { expiresIn: reapiInputUrlTtlSeconds });
            return response.status(201).json({ objectName, url, expiresIn: reapiInputUrlTtlSeconds });
        }

        if (request.method === "DELETE") {
            const objectName = request.path.replace(/^\//, "");
            if (!/^[0-9a-f-]{36}\.(?:jpg|png|webp|gif)$/.test(objectName)) return response.status(400).send("Invalid object name");
            await s3.send(new DeleteObjectCommand({ Bucket: storageConfig.bucket, Key: `reapi-inputs/${objectName}` }));
            return response.sendStatus(204);
        }

        response.setHeader("Allow", "OPTIONS, POST, DELETE");
        return response.sendStatus(405);
    } catch (error) {
        console.error("ReAPI reference upload failed", { method: request.method, status: error?.$metadata?.httpStatusCode || 502, code: error?.name || "UnknownError" });
        if (!response.headersSent) response.status(502).send("Object storage request failed");
        else response.destroy();
    }
});

app.use("/api/webdav", async (request, response) => {
    setCorsHeaders(request, response);
    if (request.method === "OPTIONS") return response.sendStatus(204);
    if (!storageConfigured || !s3) return response.status(503).send("Object storage is not configured");
    if (!isAuthorized(request.headers.authorization, storageToken)) {
        response.setHeader("WWW-Authenticate", 'Basic realm="infinite-canvas-storage"');
        return response.status(401).send("Unauthorized");
    }

    const key = request.path
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part))
        .join("/");

    try {
        if (request.method === "MKCOL") return response.sendStatus(201);
        if (request.method === "PROPFIND") {
            await s3.send(new HeadBucketCommand({ Bucket: storageConfig.bucket }));
            response.status(207).type("application/xml").send('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" />');
            return;
        }
        if (!key) return response.status(400).send("Object path is required");
        if (request.method === "PUT") {
            await s3.send(
                new PutObjectCommand({
                    Bucket: storageConfig.bucket,
                    Key: key,
                    Body: request,
                    ContentLength: contentLength(request.headers["content-length"]),
                    ContentType: request.headers["content-type"] || "application/octet-stream",
                }),
            );
            return response.sendStatus(201);
        }
        if (request.method === "GET") {
            const object = await s3.send(new GetObjectCommand({ Bucket: storageConfig.bucket, Key: key }));
            if (object.ContentType) response.type(object.ContentType);
            if (object.ContentLength !== undefined) response.setHeader("Content-Length", String(object.ContentLength));
            if (object.ETag) response.setHeader("ETag", object.ETag);
            await pipeline(object.Body, response);
            return;
        }
        response.setHeader("Allow", "OPTIONS, PROPFIND, MKCOL, GET, PUT");
        return response.sendStatus(405);
    } catch (error) {
        const status = error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey" ? 404 : 502;
        console.error("Object storage request failed", { method: request.method, key, status, code: error?.name || "UnknownError" });
        if (!response.headersSent) response.status(status).send(status === 404 ? "Not found" : "Object storage request failed");
        else response.destroy();
    }
});

if (existsSync(webRoot)) {
    writeRuntimeConfig();
    app.use(express.static(webRoot, { index: false }));
    app.use((request, response, next) => {
        if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
        response.sendFile(indexFile);
    });
}

app.use((_request, response) => response.sendStatus(404));
app.listen(port, "0.0.0.0", () => console.log(`Infinite Canvas listening on :${port}`));

function isAuthorized(header, expectedToken) {
    if (!header?.startsWith("Basic ")) return false;
    let decoded;
    try {
        decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    } catch {
        return false;
    }
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const actual = Buffer.from(decoded.slice(separator + 1));
    const expected = Buffer.from(expectedToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function setCorsHeaders(request, response) {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin || "*");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Depth");
    response.setHeader("Access-Control-Allow-Methods", "OPTIONS, PROPFIND, MKCOL, GET, PUT, POST, DELETE");
    response.setHeader("Vary", "Origin");
}

function contentLength(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function writeRuntimeConfig() {
    const sanitize = (value) => String(value || "").replace(/[^A-Za-z0-9-]/g, "");
    const config = {
        ANALYTICS_GA4_ID: sanitize(process.env.ANALYTICS_GA4_ID),
        ANALYTICS_BAIDU_ID: sanitize(process.env.ANALYTICS_BAIDU_ID),
    };
    writeFileSync(`${webRoot}/config.js`, `window.__RUNTIME_CONFIG__ = ${JSON.stringify(config)};\n`);
}
