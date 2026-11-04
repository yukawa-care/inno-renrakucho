#!/bin/bash
# 院の連絡帳を、自分のCloudflareに置く（パソコンで置くとき）
# 使い方：このフォルダで  bash oku.sh
#         お試し用として置くときは  bash oku.sh --otameshi
# 院名・店舗・スタッフ・店長などは、置いたあとにアプリの「設定」画面で決めます。
set -e
cd "$(dirname "$0")"

say(){ printf "\n\033[1m%s\033[0m\n" "$1"; }
DEMO=0; [ "$1" = "--otameshi" ] && DEMO=1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org/ja から入れてから、もう一度 bash oku.sh を打ってください。"
  exit 1
fi

say "1/6 アドレスの名前"
if [ -f .settei-zumi ]; then
  read -r -p "アドレスの名前を変えますか？（はい／Enterでいいえ）> " ANS || ANS=""
  if [ "$ANS" = "はい" ] || [ "$ANS" = "y" ]; then node settei.mjs || exit 0; else echo "前のまま進めます。"; fi
else
  node settei.mjs || exit 0
  touch .settei-zumi
fi

say "2/6 道具を入れています…（1〜2分かかることがあります）"
npm install --no-audit --no-fund >/dev/null

say "3/6 Cloudflareに入っているか確かめます"
if ! npx wrangler whoami 2>/dev/null | grep -qi "associated with the email\|You are logged in"; then
  echo "ブラウザが開きます。Cloudflareで「許可」を押してください。"
  npx wrangler login
fi

say "4/6 データベースを用意しています…"
DBNAME=$(node -e 'const s=require("fs").readFileSync("wrangler.toml","utf8");const m=s.match(/database_name = "([^"]+)"/);console.log(m?m[1]:"renrakucho-db")')
if grep -q '00000000-0000-0000-0000-000000000000\|ここに作成時に表示されたIDを入れる' wrangler.toml; then
  ID=$(npx wrangler d1 list --json 2>/dev/null | node -e '
let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{
  const d=JSON.parse(t).find(x=>x.name===process.argv[1]);console.log(d?(d.uuid||d.id||d.database_id||""):"")
}catch(e){console.log("")}})' "$DBNAME")
  if [ -z "$ID" ]; then
    ID=$(npx wrangler d1 create "$DBNAME" 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  fi
  if [ -z "$ID" ]; then echo "データベースを作れませんでした。上の表示をClaudeに見せてください。"; exit 1; fi
  node -e 'const fs=require("fs");let s=fs.readFileSync("wrangler.toml","utf8");s=s.replace(/database_id = "[^"]*"/,`database_id = "${process.argv[1]}"`);fs.writeFileSync("wrangler.toml",s)' "$ID"
fi
echo "記録の入れ物は、アプリがはじめて開かれたときに自分で作ります。"

say "5/6 置いています…"
OUT=$(npx wrangler deploy --var "DEMO:$DEMO" 2>&1) || { echo "$OUT" | tail -20; echo "置けませんでした。上の表示をClaudeに見せてください。"; exit 1; }
URL=$(echo "$OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)

INCHO=""; STAFFP=""
if [ "$DEMO" = "1" ]; then
  say "6/6 お試し用として置きました"
  echo "アドレス：${URL:-（上の表示の https://〜workers.dev）}"
  echo "合言葉なしで、役を選んで入れます。書いた内容は毎日元に戻ります。"
  exit 0
fi

say "6/6 合言葉を確かめています…"
# すでに合言葉があれば、そのまま残す（確かめられなかったときも、変えずに残す）
LIST=$(npx wrangler secret list 2>/dev/null) || LIST="INCHO_PASSCODE"
if ! echo "$LIST" | grep -q "INCHO_PASSCODE"; then
  gen(){ LC_ALL=C tr -dc 'a-hjkmnp-z2-9' </dev/urandom | head -c "$1"; }
  INCHO="incho-$(gen 8)"; STAFFP="staff-$(gen 6)"
  printf '%s' "$INCHO"  | npx wrangler secret put INCHO_PASSCODE >/dev/null
  printf '%s' "$STAFFP" | npx wrangler secret put STAFF_PASSCODE >/dev/null
fi

say "できました"
echo "アドレス：${URL:-（上の表示の https://〜workers.dev）}"
if [ -n "$INCHO" ]; then
  echo "院長の合言葉：$INCHO"
  echo "スタッフの合言葉：$STAFFP"
  echo "※この二つは紙に控えてください。画面を閉じると、もう表示されません。"
else
  echo "合言葉は前のままです。"
fi
echo "次に、アドレスを開いて院長の合言葉で入り、「はじめの設定」で院名とスタッフを入れてください。"
