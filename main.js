import { program, InvalidArgumentError } from 'commander';
import path from 'node:path';

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
