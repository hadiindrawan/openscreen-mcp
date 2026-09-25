import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { ToolError } from "../errors";
import type { Paths } from "../paths";
import { documentSchema } from "../vendor/openscreen-schema";
import type { AppCheck } from "./guard";
import type { Doc } from "./types";

export const APP_OPEN_MESSAGE =
	"OpenScreen is open. It keeps the project in memory and would overwrite this edit on its next save. Quit OpenScreen (⌘Q), then retry.";
const MAX_BACKUPS = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface LoadedProject {
	id: string;
	path: string;
	sha256: string;
	doc: Doc;
}

export interface ProjectSummary {
	id: string;
	title: string;
	updatedAt: string;
	durationSec: number;
	counts: { zooms: number; cuts: number; texts: number; blurs: number; speeds: number };
}

export interface Store {
	list(): Promise<ProjectSummary[]>;
	load(ref: string): Promise<LoadedProject>;
	save(loaded: LoadedProject, next: Doc): Promise<LoadedProject>;
	undo(ref: string): Promise<LoadedProject>;
}

interface JournalEntry {
	backup: string;
	writtenSha256: string;
	at: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function formatIssues(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("; ");
}

function summarize(id: string, doc: Doc): ProjectSummary {
	const clips = doc.timeline?.clips ?? [];
	const annotations = doc.annotations ?? [];
	const speeds = doc.legacyEditor?.speedRegions;
	return {
		id,
		title: doc.project?.title ?? id,
		updatedAt: doc.project?.updatedAt ?? "",
		durationSec: clips.reduce((max, c) => Math.max(max, c.timelineEndSec), 0),
		counts: {
			zooms: doc.zoomRanges?.length ?? 0,
			cuts: doc.timeline?.trimRanges?.length ?? 0,
			texts: annotations.filter((a) => a.type === "text").length,
			blurs: annotations.filter((a) => a.type === "blur").length,
			speeds: Array.isArray(speeds) ? speeds.length : 0,
		},
	};
}

async function atomicWrite(path: string, text: string): Promise<void> {
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmp, text);
	await rename(tmp, path);
}

async function readJournal(dir: string): Promise<JournalEntry[]> {
	try {
		return JSON.parse(await readFile(join(dir, "journal.json"), "utf8")) as JournalEntry[];
	} catch {
		return [];
	}
}

async function writeJournal(dir: string, journal: JournalEntry[]): Promise<void> {
	await atomicWrite(join(dir, "journal.json"), JSON.stringify(journal, null, 2));
}

export function createStore(
	paths: Paths,
	isAppRunning: AppCheck,
	now: () => Date = () => new Date(),
): Store {
	async function list(): Promise<ProjectSummary[]> {
		let names: string[];
		try {
			names = await readdir(paths.projectsDir);
		} catch {
			return [];
		}
		const out: ProjectSummary[] = [];
		for (const name of names.filter((n) => n.endsWith(".openscreen"))) {
			try {
				const doc = JSON.parse(await readFile(join(paths.projectsDir, name), "utf8")) as Doc;
				out.push(summarize(name.replace(/\.openscreen$/, ""), doc));
			} catch {
				// Unreadable or half-written file: leave it out of the list.
			}
		}
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async function resolveId(ref: string): Promise<string> {
		if (ref === "latest") {
			const [first] = await list();
			if (!first) throw new ToolError(`No OpenScreen projects found in ${paths.projectsDir}.`);
			return first.id;
		}
		if (!ID_PATTERN.test(ref)) {
			throw new ToolError(`"${ref}" is not a valid project id. Use list_projects.`);
		}
		return ref;
	}

	async function load(ref: string): Promise<LoadedProject> {
		const id = await resolveId(ref);
		const path = join(paths.projectsDir, `${id}.openscreen`);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			throw new ToolError(`Project ${id} not found. Use list_projects.`);
		}
		const raw = JSON.parse(text) as { schemaVersion?: unknown };
		if (raw.schemaVersion !== 7) {
			throw new ToolError(
				`Project ${id} uses schemaVersion ${String(raw.schemaVersion)}; this server supports only 7 (OpenScreen 1.12.x). Open and save it in OpenScreen first.`,
			);
		}
		const parsed = documentSchema.safeParse(raw);
		if (!parsed.success) {
			throw new ToolError(
				`Project ${id} does not match the OpenScreen v7 format: ${formatIssues(parsed.error)}`,
			);
		}
		return { id, path, sha256: sha256(text), doc: raw as Doc };
	}

	async function save(loaded: LoadedProject, next: Doc): Promise<LoadedProject> {
		if (await isAppRunning()) throw new ToolError(APP_OPEN_MESSAGE);
		const current = await readFile(loaded.path, "utf8");
		if (sha256(current) !== loaded.sha256) {
			throw new ToolError("The project changed on disk since it was read. Retry the edit.");
		}
		const doc = structuredClone(next);
		doc.project.updatedAt = now().toISOString();
		const parsed = documentSchema.safeParse(doc);
		if (!parsed.success) {
			throw new ToolError(
				`Edit rejected: the result would not be a valid OpenScreen project (${formatIssues(parsed.error)}). Nothing was written.`,
			);
		}
		const text = JSON.stringify(doc, null, 2);
		const dir = join(paths.backupsDir, loaded.id);
		await mkdir(dir, { recursive: true });
		const backup = `${now().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.openscreen`;
		await copyFile(loaded.path, join(dir, backup));
		const journal = await readJournal(dir);
		journal.push({ backup, writtenSha256: sha256(text), at: now().toISOString() });
		while (journal.length > MAX_BACKUPS) {
			const oldest = journal.shift();
			if (oldest) await rm(join(dir, oldest.backup), { force: true });
		}
		await atomicWrite(loaded.path, text);
		await writeJournal(dir, journal);
		return { ...loaded, sha256: sha256(text), doc };
	}

	async function undo(ref: string): Promise<LoadedProject> {
		if (await isAppRunning()) throw new ToolError(APP_OPEN_MESSAGE);
		const loaded = await load(ref);
		const dir = join(paths.backupsDir, loaded.id);
		const journal = await readJournal(dir);
		const last = journal.at(-1);
		if (!last) throw new ToolError("There is no edit made through this server to undo for this project.");
		if (last.writtenSha256 !== loaded.sha256) {
			throw new ToolError(
				"The project changed after the last edit made through this server (probably in the OpenScreen app), so undo would discard that work. Undo it in the app instead.",
			);
		}
		await atomicWrite(loaded.path, await readFile(join(dir, last.backup), "utf8"));
		journal.pop();
		await writeJournal(dir, journal);
		return load(loaded.id);
	}

	return { list, load, save, undo };
}
