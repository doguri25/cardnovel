// The functions only read environment variables from Node; everything else is Web standard (fetch, crypto.subtle).
declare const process: { env: Record<string, string | undefined> };
