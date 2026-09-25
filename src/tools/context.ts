import type { Cache } from "../analysis/cache";
import type { Bins } from "../analysis/media";
import type { Paths } from "../paths";
import type { Store } from "../project/store";

export interface ToolContext {
	store: Store;
	paths: Paths;
	bins: Bins;
	cache: Cache;
}
