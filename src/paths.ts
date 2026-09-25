import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
	dataDir: string;
	projectsDir: string;
	backupsDir: string;
	cacheDir: string;
	whisperModel: string;
	configDir: string;
	binDir: string;
	censorConfig: string;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
	const dataDir =
		env.OPENSCREEN_DATA_DIR ?? join(homedir(), "Library", "Application Support", "openscreen");
	const configDir = env.OPENSCREEN_MCP_HOME ?? join(homedir(), ".openscreen-mcp");
	return {
		dataDir,
		projectsDir: join(dataDir, "projects"),
		backupsDir: join(dataDir, "mcp-backups"),
		cacheDir: join(dataDir, "mcp-cache"),
		whisperModel:
			env.OPENSCREEN_WHISPER_MODEL ??
			join(dataDir, "stt-models", "whisper-ggml", "ggml-small-q8_0.bin"),
		configDir,
		binDir: env.OPENSCREEN_MCP_BIN ?? join(configDir, "bin"),
		censorConfig: join(configDir, "censor.json"),
	};
}
