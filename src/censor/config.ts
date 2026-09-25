import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ToolError } from "../errors";

export const CATEGORIES = ["money", "emails", "names", "secrets", "urls", "chrome"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Matcher {
	source: string;
	re: RegExp;
}

export interface CensorConfig {
	path: string;
	categories: Record<Category, boolean>;
	alwaysHide: Matcher[];
	neverHide: Matcher[];
	names: Matcher[];
	moneyHeaders: string[];
	nameHeaders: string[];
}

const fileSchema = z
	.object({
		categories: z
			.object({
				money: z.boolean().optional(),
				emails: z.boolean().optional(),
				names: z.boolean().optional(),
				secrets: z.boolean().optional(),
				urls: z.boolean().optional(),
				chrome: z.boolean().optional(),
			})
			.strict()
			.optional(),
		alwaysHide: z.array(z.string().min(1)).optional(),
		neverHide: z.array(z.string().min(1)).optional(),
		names: z.array(z.string().min(1)).optional(),
		moneyHeaders: z.array(z.string().min(1)).optional(),
		nameHeaders: z.array(z.string().min(1)).optional(),
	})
	.strict();

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "text" → case-insensitive substring; "/pattern/flags" → regex. Always global. */
export function compileMatcher(entry: string): Matcher {
	const regex = /^\/(.+)\/([a-z]*)$/.exec(entry);
	try {
		if (regex) {
			const flags = regex[2]!.includes("g") ? regex[2]! : `${regex[2]}g`;
			return { source: entry, re: new RegExp(regex[1]!, flags) };
		}
		return { source: entry, re: new RegExp(escapeRegex(entry), "gi") };
	} catch (error) {
		throw new ToolError(`Invalid pattern ${entry}: ${(error as Error).message}`);
	}
}

export function defaultCensorConfig(path: string): CensorConfig {
	return {
		path,
		categories: { money: true, emails: true, names: true, secrets: true, urls: true, chrome: true },
		alwaysHide: [],
		neverHide: [],
		names: [],
		moneyHeaders: [],
		nameHeaders: [],
	};
}

export async function loadCensorConfig(path: string): Promise<CensorConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return defaultCensorConfig(path);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new ToolError(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	const parsed = fileSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0]!;
		throw new ToolError(`${path}: ${issue.path.join(".") || "(root)"} ${issue.message}`);
	}
	const file = parsed.data;
	const base = defaultCensorConfig(path);
	return {
		path,
		categories: { ...base.categories, ...file.categories },
		alwaysHide: (file.alwaysHide ?? []).map(compileMatcher),
		neverHide: (file.neverHide ?? []).map(compileMatcher),
		names: (file.names ?? []).map(compileMatcher),
		moneyHeaders: file.moneyHeaders ?? [],
		nameHeaders: file.nameHeaders ?? [],
	};
}

export function restrictCategories(config: CensorConfig, only?: Category[]): CensorConfig {
	if (!only?.length) return config;
	const categories = Object.fromEntries(
		Object.entries(config.categories).map(([c, on]) => [c, on && only.includes(c as Category)]),
	) as Record<Category, boolean>;
	return { ...config, categories };
}

export function describeConfig(config: CensorConfig) {
	return {
		path: config.path,
		categories: config.categories,
		alwaysHide: config.alwaysHide.map((m) => m.source),
		neverHide: config.neverHide.map((m) => m.source),
		names: config.names.map((m) => m.source),
		moneyHeaders: config.moneyHeaders,
		nameHeaders: config.nameHeaders,
	};
}
