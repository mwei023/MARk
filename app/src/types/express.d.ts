// Local fallback declarations keep the webhook module type-safe when
// @types/express is not installed in a minimal deployment.
declare module 'express' {
  export interface Express {
    use(...args: any[]): Express;
    get(...args: any[]): Express;
    post(...args: any[]): Express;
    listen(...args: any[]): any;
  }

  export interface ExpressFactory {
    (): Express;
    json(): any;
    urlencoded(options?: any): any;
  }

  export interface Request {
    headers: Record<string, string | string[] | undefined>;
    body: any;
  }

  export interface Response {
    status(code: number): Response;
    json(body: any): Response;
    send(body: any): Response;
  }

  const express: ExpressFactory;
  export default express;
}
