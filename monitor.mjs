import { chromium } from "playwright";
import fs from "node:fs/promises";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

const MOVIES = ["스파이더맨-브랜드 뉴 데이", "오디세이"];
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

function chatIdKey() {
  return createHash("sha256").update(token).digest();
}

function encryptChatId(chatId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chatIdKey(), iv);
  const encrypted = Buffer.concat([cipher.update(chatId, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((value) => value.toString("base64url"))
    .join(".");
}

function decryptChatId(value) {
  try {
    const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", chatIdKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

async function getChatId(state) {
  if (configuredChatId) return configuredChatId;
  const savedChatId = state.chatIdCipher ? decryptChatId(state.chatIdCipher) : null;
  if (savedChatId) return savedChatId;

  const updates = await telegram("getUpdates");
  const chat = [...updates].reverse().find((item) => item.message?.chat?.id)?.message.chat.id;
  if (!chat) throw new Error("봇 채팅에서 /start를 보낸 뒤 다시 실행해 주세요.");
  const chatId = String(chat);
  state.chatIdCipher = encryptChatId(chatId);
  await saveState(state);
  return chatId;
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
    dates.push(isoDate);
  }
  return dates;
}

async function scanMovie(browser, movie) {
  const page = await browser.newPage({
    locale: "ko-KR",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
  });
  try {
    await page.goto(CGV_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.getByRole("button", { name: "예매·예약", exact: true }).click();
    await page.getByRole("button", { name: movie, exact: true }).click();

    const theater = page.getByRole("button", { name: "용산아이파크몰", exact: true });
    await theater.click();
    const closeModal = page.locator("button.btn-center-close");
    if (await closeModal.count()) await closeModal.click({ force: true });
    await page.getByRole("button", { name: "IMAX", exact: true }).click();

    await page.waitForTimeout(1500);

    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    const availableDates = [];
    const imaxDates = [];
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
      availableDates.push(date);

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
      if (hasImaxShowtime) imaxDates.push(date);
    }
    return { movie, availableDates, imaxDates };
  } finally {
    await page.close();
  }
}

function firstSeenRecord() {
  const now = new Date();
  return {
    firstSeenAt: now.toISOString(),
    firstSeenAtKst: new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      dateStyle: "short",
      timeStyle: "medium"
    }).format(now)
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const state = await readState();
  state.imaxDateOpenings ??= {};
  state.seenMovieDates ??= [];

  const results = [];
  for (const movie of MOVIES) results.push(await scanMovie(browser, movie));

  const availableDates = [...new Set(results.flatMap((result) => result.availableDates))].sort();
  const newGeneralDates = availableDates.filter((date) => !state.imaxDateOpenings[date]);
  for (const date of newGeneralDates) state.imaxDateOpenings[date] = firstSeenRecord();

  const movieDateKeys = results.flatMap((result) =>
    result.imaxDates.map((date) => `${result.movie}|${date}`)
  );
  const seenMovieDates = new Set(state.seenMovieDates);
  const newlyOpenedMovieDates = movieDateKeys.filter((key) => !seenMovieDates.has(key));

  const generalBaselineReady = state.imaxDateBaselineReady === true;
  const movieBaselineReady = state.movieDateBaselineReady === true;
  state.imaxDateBaselineReady = true;
  state.movieDateBaselineReady = true;

  if (generalBaselineReady && newGeneralDates.length) {
    const chatId = await getChatId(state);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: [
        "📅 용산 IMAX 새로운 예매 날짜 오픈",
        "CGV 용산아이파크몰 IMAX",
        `새 날짜: ${newGeneralDates.join(", ")}`,
        "",
        CGV_URL
      ].join("\n"),
      disable_web_page_preview: true
    });
  }

  if (movieBaselineReady && newlyOpenedMovieDates.length) {
    const chatId = await getChatId(state);
    const lines = newlyOpenedMovieDates.map((key) => {
      const separator = key.lastIndexOf("|");
      return `• ${key.slice(0, separator)}: ${key.slice(separator + 1)}`;
    });
    await telegram("sendMessage", {
      chat_id: chatId,
      text: [
        "🎬 용산 IMAX 영화 예매 오픈",
        ...lines,
        "",
        CGV_URL
      ].join("\n"),
      disable_web_page_preview: true
    });
  }

  state.seenMovieDates = [...new Set([...state.seenMovieDates, ...movieDateKeys])];
  await saveState(state);

  if (process.env.SEND_TEST === "true") {
    const chatId = await getChatId(state);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: [
        "✅ CGV 알리미 연결 완료",
        "CGV 용산아이파크몰 IMAX",
        "영화: 스파이더맨-브랜드 뉴 데이, 오디세이",
        "날짜 제한 없음",
        "새 예매 날짜와 실제 IMAX 상영시간을 계속 확인합니다."
      ].join("\n")
    });
  }
  console.log(JSON.stringify({ availableDates, results }, null, 2));
} finally {
  await browser.close();
}
