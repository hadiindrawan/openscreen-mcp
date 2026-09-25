import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCache } from "./analysis/cache";
import { findBins } from "./analysis/media";
import { resolvePaths } from "./paths";
import { isOpenscreenRunning } from "./project/guard";
import { createStore } from "./project/store";
import { createServer } from "./server";

const paths = resolvePaths();
const ctx = {
	paths,
	store: createStore(paths, isOpenscreenRunning),
	bins: await findBins(),
	cache: createCache(paths.cacheDir),
};
await createServer(ctx).connect(new StdioServerTransport());
console.error(`openscreen-mcp ready (data: ${paths.dataDir})`);
