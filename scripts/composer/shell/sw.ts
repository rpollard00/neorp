export {};

declare const CACHE_NAME: string;
declare const SHELL_FILES: readonly string[];

type ExtendableEvent = Event & { waitUntil: (work: Promise<unknown>) => void };
type FetchEvent = ExtendableEvent & {
  request: Request;
  respondWith: (answer: Promise<Response>) => void;
};
type WorkerScope = {
  location: Location;
  clients: { claim: () => Promise<void> };
  addEventListener: {
    (type: "install" | "activate", run: (event: ExtendableEvent) => void): void;
    (type: "fetch", run: (event: FetchEvent) => void): void;
  };
};

declare const self: WorkerScope;

const SHELL = "/";

const precache = async () => {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(
    SHELL_FILES.map((file) => new Request(file, { cache: "reload" })),
  );
};

const dropOldCaches = async () => {
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name !== CACHE_NAME).map((n) => caches.delete(n)),
  );
  await self.clients.claim();
};

const cachedShell = async (request: Request) => {
  const cache = await caches.open(CACHE_NAME);
  const key = request.mode === "navigate" ? SHELL : request;
  return (await cache.match(key)) ?? fetch(request);
};

self.addEventListener("install", (event) => event.waitUntil(precache()));

self.addEventListener("activate", (event) => event.waitUntil(dropOldCaches()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(cachedShell(request));
});
