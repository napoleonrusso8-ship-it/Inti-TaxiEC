import type { NextFunction, Request, Response } from 'express';
import { LocalStorage, type StoragePort } from '../../infra/storage.js';

/**
 * Middleware de subida para LocalStorage (PUT /v1/dev/storage). Se registra solo con DEV_TOOLS.
 * Verifica la firma (clave, expiración, tipo y tamaño máximo) antes de leer el cuerpo.
 */
export function devStorageUpload(storage: StoragePort) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'PUT' || !req.path.startsWith('/v1/dev/storage')) return next();
    if (!(storage instanceof LocalStorage)) return res.status(404).end();
    const q = req.query as Record<string, string>;
    const max = Number(q.max);
    if (!storage.verify('put', q.key ?? '', Number(q.exp), q.sig ?? '', `${q.ct}\n${max}`) || req.header('content-type') !== q.ct) return res.status(403).end();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) return res.status(413).end();
      chunks.push(chunk as Buffer);
    }
    await storage.write(q.key!, Buffer.concat(chunks));
    res.status(200).end();
  };
}
