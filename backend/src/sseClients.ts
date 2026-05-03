import { Response } from 'express';

type Channel = string;

const clients = new Map<Channel, Set<Response>>();

export function subscribe(channel: Channel, res: Response) {
  if (!clients.has(channel)) clients.set(channel, new Set());
  clients.get(channel)!.add(res);
  res.on('close', () => unsubscribe(channel, res));
}

export function unsubscribe(channel: Channel, res: Response) {
  const set = clients.get(channel);
  if (set) {
    set.delete(res);
    if (set.size === 0) clients.delete(channel);
  }
}

export function broadcast(channel: Channel, event: string, data: any) {
  const set = clients.get(channel);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    res.write(payload);
  }
}

export function broadcastSession(sessionId: number, event: string, data: any) {
  broadcast(`session:${sessionId}`, event, data);
}
