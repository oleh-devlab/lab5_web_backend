import { program, InvalidArgumentError } from 'commander';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import http from 'node:http';

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
const ALLOWED_METHODS = [];

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

function sendText(res, status, message, headers = {}) {
  res.writeHead(status, { ...TEXT_HEADERS, ...headers });
  res.end(message);
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
