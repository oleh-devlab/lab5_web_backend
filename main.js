import { program, InvalidArgumentError } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import http from 'node:http';
import superagent from 'superagent';

function parsePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError('Очікується ціле число від 1 до 65535.');
  }
  return n;
}

program
  .description('Кешуючий проксі-сервер для картинок з https://http.cat')
  .helpOption('--help', 'показати довідку')
  .requiredOption('-h, --host <address>', 'адреса сервера')
  .requiredOption('-p, --port <number>', 'порт сервера', parsePort)
  .requiredOption('-c, --cache <path>', 'шлях до теки кешу');

program.parse();
const options = program.opts();
const cacheDir = path.resolve(options.cache);

const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8' };
const ALLOWED_METHODS = ['GET', 'PUT'];
const SOURCE_HEADER = 'X-Image-Source';
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 МБ на одну картинку в PUT

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// Шлях має бути рівно "/" + три цифри; усе інше (зокрема "/../x") відкидається,
// тому ім'я файлу в кеші ніколи не будується з довільного рядка клієнта.
function parseCode(pathname) {
  const match = /^\/(\d{3})$/.exec(pathname);
  return match === null ? null : match[1];
}

function cachePath(code) {
  return path.join(cacheDir, `${code}.jpg`);
}

async function readCached(code) {
  try {
    return await readFile(cachePath(code));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function fetchFromCat(code) {
  let response;
  try {
    response = await superagent
      .get(`https://http.cat/${code}`)
      .timeout({ response: 5000, deadline: 15000 });
  } catch (err) {
    // err.status є лише тоді, коли http.cat відповів кодом 4xx/5xx;
    // без нього це мережева помилка або тайм-аут
    let reason;
    if (err.status !== undefined) reason = `http.cat відповів кодом ${err.status}`;
    else if (err.timeout) reason = 'http.cat не відповів вчасно';
    else reason = `не вдалося з'єднатися з http.cat (${err.code ?? err.message})`;
    throw new HttpError(404, `Картинку для коду ${code} не знайдено: ${reason}`);
  }

  if (!response.type.startsWith('image/') || !Buffer.isBuffer(response.body) || response.body.length === 0) {
    throw new HttpError(404, `Картинку для коду ${code} не знайдено: http.cat повернув не картинку`);
  }
  return response.body;
}

// Читає тіло запиту цілком. Потік req асинхронно ітерований: for await
// чекає кожен наступний шматок без колбеків.
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // завеликий запит дочитуємо до кінця, але не зберігаємо, щоб встигнути відповісти 413
    if (size <= MAX_BODY_SIZE) chunks.push(chunk);
  }
  if (size > MAX_BODY_SIZE) {
    throw new HttpError(413, `Тіло запиту більше за ${MAX_BODY_SIZE} байт`);
  }
  return Buffer.concat(chunks);
}

function sendText(res, status, message, headers = {}) {
  res.writeHead(status, { ...TEXT_HEADERS, ...headers });
  res.end(message);
}

function sendImage(res, image, source) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': image.length,
    [SOURCE_HEADER]: source,
  });
  res.end(image);
}

async function handleGet(code, res) {
  const cached = await readCached(code);
  if (cached !== null) {
    sendImage(res, cached, 'cache');
    return;
  }
  const image = await fetchFromCat(code);
  await writeFile(cachePath(code), image); // спершу в кеш, потім клієнтові
  sendImage(res, image, 'http.cat');
}

async function handlePut(code, req, res) {
  const body = await readBody(req);
  if (body.length === 0) {
    throw new HttpError(400, 'Тіло запиту порожнє: очікується картинка');
  }
  await writeFile(cachePath(code), body);
  sendText(res, 201, `Картинку для коду ${code} збережено в кеш`);
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    throw new HttpError(400, 'Некоректний URL запиту');
  }

  const code = parseCode(url.pathname);
  if (code === null) {
    throw new HttpError(404, `"${url.pathname}" не знайдено: шлях має бути тризначним кодом стану, наприклад /404`);
  }

  switch (req.method) {
    case 'GET':
      await handleGet(code, res);
      break;
    case 'PUT':
      await handlePut(code, req, res);
      break;
    default:
      throw new HttpError(405, `Метод ${req.method} не підтримується`, { Allow: ALLOWED_METHODS.join(', ') });
  }
}

// http не чекає проміс, який повертає обробник, і не ловить його помилки,
// тому всі винятки ловимо тут: сервер має відповісти й працювати далі.
const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    if (err instanceof HttpError) {
      sendText(res, err.status, err.message, err.headers);
    } else {
      console.error(`${req.method} ${req.url}:`, err);
      sendText(res, 500, 'Внутрішня помилка сервера');
    }
  }
});

try {
  await mkdir(cacheDir, { recursive: true });
} catch (err) {
  program.error(`Не вдалося створити теку кешу "${cacheDir}": ${err.message}`);
}

server.listen(options.port, options.host);
try {
  // once() перетворює подію на проміс: виконується на 'listening', відхиляється на 'error'
  await once(server, 'listening');
} catch (err) {
  console.error(`Не вдалося запустити сервер: ${err.message}`);
  process.exit(1);
}
console.log(`Сервер запущено: http://${options.host}:${options.port}/ (кеш: ${cacheDir})`);
