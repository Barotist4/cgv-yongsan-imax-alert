import { chromium } from "playwright";
import fs from "node:fs/promises";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

const CGV_URL = "https://cgv.co.kr/cnm/movieBook/cinema";
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

  // CGV 달력에 한 달 뒤 특별 상영 일정이 먼저 열리는 경우도 있어
  // 오늘부터 35일 뒤까지 화면에 실제로 존재하는 날짜를 확인합니다.
  for (let offset = 0; offset <= 35; offset += 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() + offset);
    const isoDate = date.toISOString().slice(0, 10);
    dates.push(isoDate);
  }
  return dates;
}

async function scanYongsanImax(browser) {
  const page = await browser.newPage({
    locale: "ko-KR",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
  });
  try {
    await page.goto(CGV_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    const theater = page.getByRole("button", { name: "용산아이파크몰", exact: true });
    await theater.waitFor({ state: "visible", timeout: 30000 });
    await theater.click();

    await page.getByRole("button", { name: "극장 속성", exact: true }).click();
    await page.getByRole("button", { name: "아이맥스", exact: true }).click();
    await page.getByRole("button", { name: "확인", exact: true }).click();
    await page.waitForTimeout(1000);

    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    const scannedDates = [];
    const imaxOpenDates = [];
    const movieDates = {};

    const futureDates = visibleFutureDates();
    for (const date of futureDates) {
      const parsed = new Date(`${date}T00:00:00Z`);
      const weekday = weekdays[parsed.getUTCDay()];
      const day = parsed.getUTCDate();
      const isToday = date === futureDates[0];
      const prefix = isToday ? "(?:오늘|" + weekday + ")" : weekday;
      const dateName = new RegExp(`^${prefix}\\s+0?${day}$`);
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
      scannedDates.push(date);

      await clickableDateButton.click();
      // 날짜를 바꾸면 CGV가 SPA 요청으로 시간표를 다시 그립니다.
      // 너무 빨리 읽으면 이전/빈 화면을 보게 되므로 렌더링을 기다립니다.
      await page.waitForTimeout(1200);

      const schedule = await page.locator("h2").evaluateAll((headings) => {
        // 종료 시각 바로 뒤에 잔여석 숫자가 붙어도 시간표로 인식합니다.
        const timePattern = /\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/;
        const normalized = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const foundMovies = [];
        let hasImaxShowtime = false;

        for (const heading of headings) {
          const section = heading.parentElement;
          if (!section) continue;
          const screenHeadings = [...section.querySelectorAll("h3")];
          const isImaxSection = screenHeadings.some((item) =>
            normalized(item.textContent).includes("IMAX")
          );
          if (!isImaxSection) continue;
          const hasTime = [...section.querySelectorAll("button")].some((button) =>
            timePattern.test(normalized(button.textContent))
          );
          if (!hasTime) continue;

          hasImaxShowtime = true;
          const headingText = normalized(heading.textContent);
          if (headingText) foundMovies.push(headingText);
        }
        return { hasImaxShowtime, foundMovies: [...new Set(foundMovies)] };
      });

      if (schedule.hasImaxShowtime) imaxOpenDates.push(date);
      for (const movie of schedule.foundMovies) {
        movieDates[movie] ??= [];
        movieDates[movie].push(date);
      }
    }

    if (!scannedDates.length) {
      throw new Error("용산아이파크몰의 활성화된 예매 날짜를 찾지 못했습니다. CGV 화면 구조를 확인해 주세요.");
    }

    return { scannedDates, imaxOpenDates, movieDates };
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

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
});
try {
  const state = await readState();
  state.imaxDateOpenings ??= {};
  state.seenMovieDates ??= [];

  const result = await scanYongsanImax(browser);
  const newGeneralDates = result.imaxOpenDates.filter((date) => !state.imaxDateOpenings[date]);
  for (const date of newGeneralDates) state.imaxDateOpenings[date] = firstSeenRecord();

  const movieDateKeys = Object.entries(result.movieDates).flatMap(([movie, dates]) =>
    dates.map((date) => `${movie}|${date}`)
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
        "대상: 용산아이파크몰 IMAX의 모든 영화",
        "날짜 제한 없음",
        "새 예매 날짜와 실제 IMAX 상영시간을 계속 확인합니다."
      ].join("\n")
    });
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
