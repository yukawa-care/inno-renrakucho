// 院の連絡帳：アドレスの名前を決める（パソコンで置くとき）
// 院名・店舗・スタッフ・店長などは、置いたあとにアプリの「設定」画面で決めます。
// 使い方：bash oku.sh の中から呼ばれます。

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const FILE = new URL("./wrangler.toml", import.meta.url);
const rl = createInterface({ input: stdin, terminal: false });
const lines = [], waiting = [];
let closed = false;
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on("close", () => { closed = true; while (waiting.length) waiting.shift()(null); });
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve(null) : new Promise((r) => waiting.push(r)));
const gray = (s) => `\x1b[90m${s}\x1b[0m`;

let toml = readFileSync(FILE, "utf8");
const oldName = (toml.match(/^name = "(.*)"$/m) || [])[1] || "renraku";

console.log(gray("アドレスは https://（ここで決める名前）.（Cloudflareのアカウント名）.workers.dev になります。"));
console.log(gray("使える文字は、英語の小文字・数字・ハイフン（-）だけです。例：sakura-renraku"));
let name;
for (;;) {
  stdout.write(`アドレスの名前は？ ${gray(`（そのままEnterで「${oldName}」）`)}\n> `);
  const line = await nextLine();
  if (line === null) { console.log("\n入力が終わったので、止めます。"); process.exit(2); }
  name = line.trim() || oldName;
  if (/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(name)) break;
  console.log("  英語の小文字・数字・ハイフンで、3〜40文字にしてください（最初と最後はハイフン以外）。");
}
rl.close();
if (name !== oldName) console.log("※アドレスの名前が前と変わります。新しいアドレスで置き、合言葉も新しく出ます。記録は引き継がれます。");
toml = toml.replace(/^name = ".*"$/m, `name = "${name}"`);
writeFileSync(FILE, toml);
