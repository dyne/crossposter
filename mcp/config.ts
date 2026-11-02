import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { isControlOrigin, readControlCredential } from "../lib/control/credential";
import { controlMediaSettings } from "../lib/control/media-settings";
import { ControlError } from "../lib/control/errors";

export function bridgeConfig(environment: NodeJS.ProcessEnv) {
  const root = environment.CROSSPOSTER_DATA_DIR;
  const origin = environment.CROSSPOSTER_MCP_ENDPOINT;
  if (!root || !path.isAbsolute(root) || !origin || !isControlOrigin(origin)
    || !environment.CROSSPOSTER_MCP_MEDIA_ROOTS) throw new ControlError("validation_failed");
  const setup = readControlCredential(root);
  if (setup.credential.origin !== origin) throw new ControlError("instance_mismatch");
  try {
    const media = controlMediaSettings((key) => environment[key]);
    const localRoots = media.localRoots.map((item) => {
      const canonical = realpathSync(item);
      if (!statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    });
    return { ...setup, origin, media: { ...media, localRoots } };
  } catch { throw new ControlError("validation_failed"); }
}
export type BridgeConfig = ReturnType<typeof bridgeConfig>;
