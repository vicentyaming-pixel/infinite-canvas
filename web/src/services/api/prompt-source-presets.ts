import { nanoid } from "nanoid";

export type PromptSource = {
    id: string;
    name: string;
    url: string;
    homepage: string;
    enabled: boolean;
    builtIn: boolean;
};

const MEDICAL_AESTHETIC_LIBRARY_HOMEPAGE = "https://github.com/vicentyaming-pixel/infinite-canvas/tree/rainyun-oss/web/public/prompts";

export function createPromptSource(source?: Partial<PromptSource>): PromptSource {
    return {
        id: source?.id?.trim() || nanoid(),
        name: source?.name?.trim() || "",
        url: source?.url?.trim() || "",
        homepage: source?.homepage?.trim() || "",
        enabled: source?.enabled ?? true,
        builtIn: source?.builtIn ?? false,
    };
}

export const DEFAULT_PROMPT_SOURCES: PromptSource[] = [
    bundledSource("medical-before", "医美案例 · 术前标准照", "medical-before.json"),
    bundledSource("medical-after", "医美案例 · 术后标准照", "medical-after.json"),
    bundledSource("medical-candid", "医美案例 · 术后素人照", "medical-candid.json"),
    bundledSource("medical-quality", "医美案例 · 真实感质检", "medical-quality.json"),
];

function bundledSource(id: string, name: string, fileName: string): PromptSource {
    return { id, name, url: `/prompts/${fileName}`, homepage: MEDICAL_AESTHETIC_LIBRARY_HOMEPAGE, enabled: true, builtIn: true };
}
