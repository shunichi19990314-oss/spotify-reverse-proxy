/**
 * HTML へのランタイムパッチ注入。
 * 必ず rewriteText() を適用した「後」に呼ぶこと（自分のスクリプトが書き換えられるのを防ぐ）。
 */

const HEAD_RE = /<head[^>]*>/i;
const HTML_RE = /<html[^>]*>/i;

/**
 * <head> の直後（＝他のどのスクリプトよりも前）に <script> を差し込む。
 * 見つからなければ <html> の直後、それも無ければ文頭。
 */
export function injectClientScript(html, scriptSource) {
  const tag = `<script data-spx="runtime">${scriptSource}</script>`;

  const head = HEAD_RE.exec(html);
  if (head) {
    const pos = head.index + head[0].length;
    return html.slice(0, pos) + tag + html.slice(pos);
  }

  const root = HTML_RE.exec(html);
  if (root) {
    const pos = root.index + root[0].length;
    return html.slice(0, pos) + tag + html.slice(pos);
  }

  return tag + html;
}
