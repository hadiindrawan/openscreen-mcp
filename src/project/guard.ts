import { execFile } from "node:child_process";

export type AppCheck = () => Promise<boolean>;

/** True while the OpenScreen app (process name exactly "Openscreen") is running. */
export const isOpenscreenRunning: AppCheck = () =>
	new Promise((resolve, reject) => {
		execFile("/usr/bin/pgrep", ["-x", "Openscreen"], (error) => {
			if (!error) resolve(true);
			else if (error.code === 1) resolve(false);
			else reject(error);
		});
	});
