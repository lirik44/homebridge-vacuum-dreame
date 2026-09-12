import type { Socket } from 'node:net';

// `node-miio` ships no typings. Only the surface this plugin uses is declared here: the
// connection itself plus the raw `call`, since every read and command goes through MIoT.

declare module 'node-miio' {
  export function device(options: MiioDeviceOptions): Promise<MiioDevice>;

  export interface MiioDeviceOptions {
    address: string;
    token: string;
  }

  export interface MiioDevice {
    /** The model the robot reports during the handshake, e.g. `dreame.vacuum.p2008`. */
    miioModel?: string;
    /**
     * The socket is reached through the handle to tell a live connection from a destroyed one.
     *
     * @see https://github.com/aholstenson/miio/blob/master/lib/network.js
     */
    handle: {
      api: {
        parent: {
          get socket(): Socket;
        };
      };
    };
    call: <T>(method: string, args?: unknown) => Promise<T>;
    destroy: () => void;
    matches: (query: string) => boolean;
  }
}
