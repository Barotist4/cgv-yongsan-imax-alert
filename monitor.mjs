import { chromium } from "playwright";
import fs from "node:fs/promises";

const MOVIE = "스파이더맨-브랜드 뉴 데이";
const START_DATE = "2026-08-05";
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

function visibleFutureDates() {
  const todayInKorea = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const today = new Date(`${todayInKorea}T00:00:00Z`);
  const dates = [];

  // CGV가 한 번에 보여 주는 범위보다 넉넉하게 생성합니다.
  // 실제 화면에 존재하고 활성화된 날짜만 아래에서 확인합니다.
  for (let offset = 0; offset <= 14; offset += 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() + offset);
    const isoDate = date.toISOString().slice(0, 10);
    if (isoDate >= START_DATE) dates.push(isoDate);
  }
  return dates;
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

  const theater = page.getByRole("button", { name: "용산아이파크몰", exact: true });
  await theater.click();
  const closeModal = page.locator("button.btn-center-close");
  if (await closeModal.count()) await closeModal.click({ force: true });
  await page.getByRole("button", { name: "IMAX", exact: true }).click();

  await page.waitForTimeout(1500);

  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const foundDates = [];
  for (const date of visibleFutureDates()) {
    const parsed = new Date(`${date}T00:00:00Z`);
    const weekday = weekdays[parsed.getUTCDay()];
    const month = parsed.getUTCMonth() + 1;
    const day = parsed.getUTCDate();
    const dateName = new RegExp(`^${weekday}\\s+(?:${month}\\.)?0?${day}$`);
    const dateButtons = page.getByRole("button", { name: dateName });

    let clickableDateButton = null;
    for (let index = 0; index < await dateButtons.count(); index += 1) {
      const candidate = dateButtons.nth(index);
      if (await candidate.isVisible() && await candidate.isEnabled()) {
        clickableDateButton = candidate;
        break;
      }
    }
    if (!clickableDateButton) continue;

    await clickableDateButton.click();
    await page.waitForTimeout(700);

    const hasImaxShowtime = await page.locator("h3").evaluateAll((headings) =>
      headings.some((heading) => {
        if (!heading.textContent?.trim().startsWith("IMAX관")) return false;
        const section = heading.parentElement;
        return [...(section?.querySelectorAll("button") ?? [])].some((button) =>
          /\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/.test(button.textContent ?? "")
        );
      })
    );
    if (hasImaxShowtime) foundDates.push(date);
  }

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
  if (process.env.SEND_TEST === "true") {
    const chatId = await getChatId();
    await telegram("sendMessage", {
      chat_id: chatId,
      text: [
        "✅ CGV 알리미 연결 완료",
        MOVIE,
        "CGV 용산아이파크몰 IMAX",
        "대상 기간: 2026-08-05 이후 모든 공개 일정",
        "앞으로 5분마다 확인합니다."
      ].join("\n")
    });
  }
  console.log(foundDates.length ? `감지: ${foundDates.join(", ")}` : "아직 대상 일정이 없습니다.");
} finally {
  await browser.close();
}
