export type RecordedProviderRequest = {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
};

type FakeProviderHandler = (
  request: Request,
  recorded: RecordedProviderRequest,
) => Response | Promise<Response>;

export function startFakeImageProvider(handler: FakeProviderHandler) {
  const requests: RecordedProviderRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const recorded = {
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        body: await request.text(),
      };
      requests.push(recorded);
      return handler(request, recorded);
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}
