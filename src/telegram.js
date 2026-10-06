const fs = require('fs');

const TELEGRAM_API = 'https://api.telegram.org';

function formatAlert(details, reason, liveViewUrl) {
  const reasonLine =
    reason === 'success'
      ? '✅ Бронь создана автоматически.'
      : reason === 'captcha'
      ? '⚠️ CAPTCHA появился — нужно подтвердить бронь вручную.'
      : '⚠️ Не удалось оформить бронь автоматически — нужно занести вручную.';

  return [
    reasonLine,
    liveViewUrl ? `\n👉 Открыть страницу и нажать «Я не робот» → «Забронировать»:\n${liveViewUrl}` : null,
    '',
    `Имя: ${details.name}`,
    `Телефон: ${details.phone}`,
    `Дата: ${details.date}`,
    `Время: ${details.time}`,
    `Гостей: ${details.guests_count}`,
    details.comment ? `Комментарий: ${details.comment}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

async function sendReservationAlert(details, { reason, screenshotPath, errorMessage, liveViewUrl } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, cannot alert.');
    return;
  }

  let text = formatAlert(details, reason, liveViewUrl);
  if (errorMessage) text += `\n\nТехническая деталь: ${errorMessage}`;

  try {
    await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const body = new FormData();
      body.append('chat_id', chatId);
      body.append('photo', new Blob([fs.readFileSync(screenshotPath)]), 'screenshot.png');
      await fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, { method: 'POST', body });
    }
  } catch (err) {
    console.error('[telegram] Failed to send alert:', err);
  }
}

module.exports = { sendReservationAlert };
