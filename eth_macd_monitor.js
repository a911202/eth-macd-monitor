/**
 * ETH 15M MACD Cross Monitor - Feishu Notification
 * 
 * Only monitors the 15-minute timeframe.
 * Notifies on golden cross (金叉) or death cross (死叉).
 * 30-minute cooldown per signal type to avoid spam.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Config ---
const SCRIPT_DIR = __dirname;
const STATE_FILE = path.join(SCRIPT_DIR, 'eth_macd_15m_state.json');
const BASE_URL = 'https://data-api.binance.vision/api/v3/klines';
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown per signal type

const WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || '';

// --- MACD Calculation ---
function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = ema(dif, 9);
  const histogram = dif.map((v, i) => 2 * (v - dea[i]));
  return { dif, dea, histogram };
}

function detectCross(macd) {
  if (!macd) return null;
  const len = macd.dif.length;
  const prevDif = macd.dif[len - 2];
  const prevDea = macd.dea[len - 2];
  const currDif = macd.dif[len - 1];
  const currDea = macd.dea[len - 1];

  if (prevDif <= prevDea && currDif > currDea) return 'golden';
  if (prevDif >= prevDea && currDif < currDea) return 'death';
  return null;
}

// --- Data Fetching ---
function fetchBinanceKlines(interval, limit) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}?symbol=ETHUSDT&interval=${interval}&limit=${limit}`;
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed)) {
            reject(new Error(`Unexpected response: ${data.substring(0, 200)}`));
            return;
          }
          const klines = parsed.map(k => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          }));
          resolve(klines);
        } catch (e) {
          reject(new Error(`Parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// --- Feishu Webhook Notification ---
function sendFeishuWebhook(title, content) {
  return new Promise((resolve, reject) => {
    if (!WEBHOOK_URL) {
      console.log('No webhook URL configured, skipping notification');
      return resolve(false);
    }

    const url = new URL(WEBHOOK_URL);
    const payload = JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: title },
          template: title.includes('金叉') ? 'green' : title.includes('死叉') ? 'red' : 'blue',
        },
        elements: [
          {
            tag: 'markdown',
            content: content,
          },
          {
            tag: 'note',
            elements: [
              { tag: 'plain_text', content: '⚠️ 技术指标信号，不构成投资建议' },
            ],
          },
        ],
      },
    });

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.code === 0 || result.StatusCode === 0) {
            console.log('✅ Webhook notification sent');
            resolve(true);
          } else {
            console.error('Webhook error:', data);
            resolve(false);
          }
        } catch (e) {
          console.error('Parse error:', data.substring(0, 200));
          resolve(false);
        }
      });
    });

    req.on('error', (e) => { console.error('Webhook request failed:', e.message); resolve(false); });
    req.on('timeout', () => { req.destroy(); console.error('Webhook timeout'); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// --- State Management ---
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) { console.error('State load error:', e.message); }
  return { lastNotifications: {}, lastCheck: null };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) { console.error('State save error:', e.message); }
}

// --- Startup Notification ---
const STARTUP_NOTIFY = process.env.STARTUP_NOTIFY === '1';

// --- Main ---
async function main() {
  console.log(`\n=== ETH 15M MACD Cross Monitor ===`);
  console.log(`Time: ${new Date().toISOString()} (CST: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);
  console.log(`Webhook: ${WEBHOOK_URL ? 'configured' : 'NOT configured'}`);

  const state = loadState();
  const now = Date.now();

  try {
    console.log('Fetching 15M klines...');
    const klines = await fetchBinanceKlines('15m', 150);
    console.log(`  Got ${klines.length} candles`);

    const closes = klines.map(k => k.close);
    const macd = calcMACD(closes);

    if (!macd) {
      console.log('⚠ Not enough data');
      return;
    }

    const cross = detectCross(macd);
    const lastClose = closes[closes.length - 1];
    const lastDif = macd.dif[macd.dif.length - 1];
    const lastDea = macd.dea[macd.dea.length - 1];
    const lastHist = macd.histogram[macd.histogram.length - 1];

    const trend = lastDif > lastDea ? '偏多' : '偏空';
    console.log(`  ETH=${lastClose.toFixed(2)}  DIF=${lastDif.toFixed(4)}  DEA=${lastDea.toFixed(4)}  HIST=${lastHist.toFixed(4)}  trend=${trend}  cross=${cross || 'none'}`);

    if (cross) {
      const signalType = cross; // 'golden' or 'death'
      const lastNotif = state.lastNotifications[signalType];
      const canNotify = !lastNotif || (now - lastNotif) > COOLDOWN_MS;

      if (canNotify) {
        const emoji = cross === 'golden' ? '🔴🚀' : '🟢⚠️';
        const crossName = cross === 'golden' ? '金叉' : '死叉';
        const direction = cross === 'golden' ? '看多信号' : '看空信号';
        const title = `${emoji} ETH 15分钟MACD${crossName}！`;

        const content = [
          `**${direction}**：15分钟MACD${crossName}`,
          '',
          `**价格** ${lastClose.toFixed(2)}`,
          `**DIF** ${lastDif.toFixed(4)}`,
          `**DEA** ${lastDea.toFixed(4)}`,
          `**柱状图** ${lastHist.toFixed(4)}`,
          '',
          `检测时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        ].join('\n');

        console.log('\n🔔 SIGNAL DETECTED!');
        console.log(title);
        console.log(content);

        const sent = await sendFeishuWebhook(title, content);
        if (sent) {
          state.lastNotifications[signalType] = now;
        }
      } else {
        const remainMin = Math.ceil((COOLDOWN_MS - (now - lastNotif)) / 60000);
        console.log(`\n  ℹ ${cross === 'golden' ? '金叉' : '死叉'}信号冷却中，剩余 ${remainMin} 分钟`);
      }
    } else {
      console.log('\n  ℹ 无金叉/死叉信号');
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
  }

  // Startup notification
  if (STARTUP_NOTIFY) {
    console.log('\n📢 Sending startup notification...');
    await sendFeishuWebhook(
      '✅ ETH 15M MACD监控已启动',
      [
        '**监控服务已上线**',
        '',
        `启动时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        '运行环境：GitHub Actions',
        '监控周期：每5分钟',
        '',
        '此消息仅为启动确认，后续仅在检测到金叉/死叉时推送通知。',
      ].join('\n')
    );
  }

  state.lastCheck = now;
  saveState(state);
  console.log('\n=== Done ===');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
