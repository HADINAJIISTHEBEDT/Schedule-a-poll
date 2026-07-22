function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulates natural human behavior before sending a message:
 * pause, typing indicator, and typing duration based on content length.
 */
async function humanLikeDelay(chat, text, { minSeconds = 3, maxSeconds = 12 } = {}) {
  const initialPause = randomBetween(minSeconds * 1000, maxSeconds * 1000);
  await sleep(initialPause);

  const typingDuration = Math.min(
    randomBetween(1500, 4000) + text.length * randomBetween(30, 80),
    20000
  );

  try {
    await chat.sendStateTyping();
    await sleep(typingDuration);
    if (typeof chat.clearState === 'function') {
      await chat.clearState();
    }
  } catch {
    await sleep(typingDuration);
  }
}

/**
 * Staggers delivery across multiple chats so sends don't look automated.
 */
async function staggeredChatDelay(index, { minSeconds = 5, maxSeconds = 25 } = {}) {
  if (index === 0) return;

  const baseDelay = randomBetween(minSeconds * 1000, maxSeconds * 1000);
  const jitter = randomBetween(0, 5000);
  await sleep(baseDelay + jitter);
}

module.exports = { humanLikeDelay, staggeredChatDelay, sleep, randomBetween };
