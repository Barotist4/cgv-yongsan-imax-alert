import { chromium } from "playwright";
import fs from "node:fs/promises";

const MOVIE = "스파이더맨-브랜드 뉴 데이";
const DATES = ["2026-08-07", "2026-08-08", "2026-08-09"];
const CGV_URL = "https://cgv.co.kr/cnm/cgvChart/movieChart/30001192";
const STATE_FILE = new URL("./state.json", import.meta.url);

const token = process.env.TELEGRAM_BOT_TOKEN;
const configuredChatId = process.env.TELEGRAM_CHAT_ID;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN이 설정되지 않았습니다.");

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} 오류: ${result.description}`);
  return result.result;
}

async function getChatId() {
  if (configuredChatId) return configuredChatId;
  const updates = await telegram("getUpdates");
  const chat = [...updates].reverse().find((item) => item.message?.chat?.id)?.message.chat.id;
  if (!chat) throw new Error("봇 채팅에서 /start를 보낸 뒤 다시 실행해 주세요.");
  return String(chat);
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return { notified: [] };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    locale: "ko-KR",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
  });
  await page.goto(CGV_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("button", { name: "예매·예약", exact: true }).click();
  await page.getByRole("button", { name: MOVIE, exact: true }).click();
  await page.getByRole("button", { name: "IMAX", exact: true }).click();

  const theater = page.getByRole("button", { name: "용산아이파크몰", exact: true });
  if (await theater.count()) await theater.click();

  await page.waitForTimeout(2500);
  const pageText = await page.locator("body").innerText();
  const foundDates = DATES.filter((date) => {
    const [year, month, day] = date.split("-");
    return pageText.includes(date)
      || pageText.includes(`${year}.${month}.${day}`)
      || pageText.includes(`${Number(month)}월 ${Number(day)}일`);
  });

  const state = await readState();
  const newlyOpened = foundDates.filter((date) => !state.notified.includes(date));
  if (newlyOpened.length) {
    const chatId = await getChatId();
    await telegram("sendMessage", {
      chat_id: chatId,
      text: [
        "🎬 CGV 예매 오픈 감지",
        MOVIE,
        "CGV 용산아이파크몰 IMAX",
        `날짜: ${newlyOpened.join(", ")}`,
        "",
        CGV_URL
      ].join("\n"),
      disable_web_page_preview: true
    });
    state.notified = [...new Set([...state.notified, ...newlyOpened])];
    await saveState(state);
  }
  console.log(foundDates.length ? `감지: ${foundDates.join(", ")}` : "아직 대상 일정이 없습니다.");
} finally {
  await browser.close();
}
