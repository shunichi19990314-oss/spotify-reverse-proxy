import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const ASSET = fileURLToPath(new URL("../assets/spx-client.js", import.meta.url));
const DEMO_ASSET = fileURLToPath(new URL("../assets/demo.html", import.meta.url));
const VERSION = "1.0.0";

/**
 * assets/spx-client.js を読み込み、プレースホルダを実値に置換した
 * インライン <script> 用ソースを返す。起動時に一度だけ実行する。
 */
export function buildClientScript() {
  let src = readFileSync(ASSET, "utf8");
  src = src
    .replace(/__SPX_DOMAINS__/g, JSON.stringify(config.allowDomains))
    .replace(/__SPX_HOST_PREFIX__/g, config.hostPrefix)
    .replace(/__SPX_WS_PREFIX__/g, config.wsPrefix)
    .replace(/__SPX_VERSION__/g, VERSION);
  return src;
}

/** /__spx/demo で配信する iframe 表示デモページ */
export function buildDemoPage() {
  return readFileSync(DEMO_ASSET, "utf8");
}
