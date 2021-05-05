#!/usr/bin/env -S node --experimental-wasi-unstable-preview1 --experimental-wasm-bigint --experimental-wasm-mv

"use strict";

/*
 * Author: Volodymyr Shymanskyy
 */

const fs = require("fs");
const assert = require("assert");
const chalk = require("chalk");
const r = require("restructure");

/*
 * Features
 *
 * [+]  Load wasm and wat files
 * [+]  Run arbitrary wasm function
 * [+]  Run single exported function by default
 * [+]  Run wasi-snapshot-preview1 apps
 * [+]  Run wasi-unstable apps (compatibility layer)
 * [+]  Return exitcode
 * [X]  (!!!) Caching - blocked by https://github.com/nodejs/node/issues/36671
 * [+]  Generic imports tracing
 * [+]  BigInt args support
 * [ ]  --mapdir flag
 * [ ]  WASI API + structures decoding (generate from witx?)
 * [ ]  REPL mode
 */


/*
 * Arguments
 */

const argv = require("yargs")
    .usage("$0 [options] <file> [args..]")
    .example('$0 fib32.wasm 32',                         '')
    .example('$0 fib64.wasm 32',                         '')
    .example('$0 mal.wasm',                              '')
    .example('$0 mal.wasm ./mal-fib.mal 11',             '')
    .example('$0 mal.wasm ./mal.mal ./mal-fib.mal 11',   '')
    .example('$0 test-wasi-unstable.wasm',               '')
    .example('$0 test-wasi-snapshot-preview1.wasm',      '')
    .option({
      // Instrumentation options
      "invoke": {
        alias: "i",
        type: "string",
        describe: "Function to execute",
        nargs: 1
      },
      "trace": {
        type: "boolean",
        describe: "Trace imported function calls",
      },
    })
    .string('_')
    .strict()
    .version()
    .help()
    .wrap(null)
    .argv;

/*
 * Helpers
 */

function fatal(msg) {
  console.error(chalk.grey('[tracer] ') + chalk.red.bold("Error: ") + msg);
  process.exit(1);
}

function warn(msg) {
  console.error(chalk.grey('[tracer] ') + chalk.yellow.bold("Warning: ") + msg);
}

function log(msg) {
  console.error(chalk.grey('[tracer] ') + msg);
}

class EncodeBuffer {
  constructor(bufferSize) {
    bufferSize = bufferSize || 65536;

    this.pos = 0;
    this.buff = Buffer.alloc(bufferSize);

    for (let key in Buffer.prototype) {
      if (key.slice(0, 5) === 'write') {
        (function(key) {
          const bytes = r.DecodeStream.TYPES[key.replace(/write|[BL]E/g, '')];
          return EncodeBuffer.prototype[key] = function(value) {
            this.buff[key](value, this.pos);
            return this.pos += bytes;
          };
        })(key);
      }
    }
  }

  get buffer() {
    return this.buff.slice(0, this.pos);
  }

  writeString(string, encoding) {
    encoding = encoding || 'ascii';

    switch (encoding) {
      case 'utf16le':
      case 'ucs2':
      case 'utf8':
      case 'ascii':
        return this.writeBuffer(Buffer.from(string, encoding));
      default:
        throw new Error('String encoding need to be implemented with iconv-lite.');
    }
  }

  writeBuffer(buffer) {
    buffer.copy(this.buff, this.pos);
    return this.pos += buffer.length;
  }

  fill(val, length) {
    this.buff.fill(val, this.pos, this.pos + length);
    return this.pos += length;
  }
}

function encodeStruct(T, data) {
  let encoder = new EncodeBuffer(T.size());
  T.encode(encoder, data);
  assert.equal(encoder.buffer.length, T.size());
  return encoder.buffer;
};

function decodeStruct(T, buff) {
  buff = new Buffer(buff);
  assert.equal(buff.length, T.size());
  return T.decode(new r.DecodeStream(buff));
};

/*
async function wat2wasm(binary)
{
    const wat = binary.toString()
        .replace(/\(\;.*?\;\)/,  '')
        .replace(/local\.get/g,  'get_local')
        .replace(/global\.get/g, 'get_global')
        .replace(/local\.set/g,  'set_local')
        .replace(/global\.set/g, 'set_global');

    const wabt = await (require("wabt")());

    const module = wabt.parseWat("mod.wasm", wat);
    module.resolveNames();
    module.validate();

    let result = module.toBinary({
        log: false,
        write_debug_names: true,
        canonicalize_lebs: true,
        relocatable: true,
    }).buffer;

    return result;
}
*/

async function wat2wasm(binary)
{
    const Binaryen = require("binaryen");
    Binaryen.setDebugInfo(true);

    const wat = binary.toString()
        .replace(/get_local/g,  'local.get')
        .replace(/get_global/g, 'global.get')
        .replace(/set_local/g,  'local.set')
        .replace(/set_global/g, 'global.set');

    let module = Binaryen.parseText(wat);
    let result = module.emitBinary();
    module.dispose();

    return result;
}

async function parseWasmInfo(binary)
{
    const Binaryen = require("binaryen");
    Binaryen.setDebugInfo(true);

    let module = Binaryen.readBinary(binary);

    function decodeType(t) {
        switch (t) {
        case Binaryen.none: return "none";
        case Binaryen.i32:  return "i32";
        case Binaryen.i64:  return "i64";
        case Binaryen.f32:  return "f32";
        case Binaryen.f64:  return "f64";
        case Binaryen.v128: return "v128";
        case Binaryen.funcref: return "funcref";
        case Binaryen.anyref:  return "anyref";
        case Binaryen.nullref: return "nullref";
        case Binaryen.exnref:  return "externref";
        default:               return "unknown";
        }
    }

    let result = {
        funcsByIndex: [],
        funcsByName: {}
    };

    for (let i = 0; i < module.getNumFunctions(); i++) {
        let info = Binaryen.getFunctionInfo(module.getFunctionByIndex(i));

        result.funcsByIndex[i] = result.funcsByName[info.name] = {
            index:      i,
            params:     Binaryen.expandType(info.params).map(x => decodeType(x)),
            results:    Binaryen.expandType(info.results).map(x => decodeType(x)),
        }
    }

    for (let i = 0; i < module.getNumExports(); i++) {
        let exp = Binaryen.getExportInfo(module.getExportByIndex(i));

        if (exp.kind == Binaryen.ExternalFunction) {
            let item = result.funcsByName[exp.value];
            result.funcsByName[exp.name] = item;
        }
    }

    module.dispose();

    return result;
}


/*******************************************************************
 * Main
 *******************************************************************/

(async () => {
    const inputFile = argv._[0]

    if (!inputFile) {
        fatal(`Please specify input file. See ${chalk.white.bold('--help')} for details.`);
    }

    let binary;
    try {
        binary = fs.readFileSync(inputFile);
    } catch (e) {
        fatal(`File ${chalk.white.bold(inputFile)} not found`);
    }
    
    if (inputFile.endsWith('.wat')) {
        binary = await wat2wasm(binary);
        log(`Converted to binary (${binary.length} bytes)`);
    }

    /*
     * Compile
     */
    
    /* TODO: caching
        const v8 = require('v8');
        const compiled = await WebAssembly.compile(binary);
        const cached = v8.serialize(compiled);
        binary = v8.deserialize(cached);
    */
    
    let module = await WebAssembly.compile(binary);

    /*
     * Analyze
     */

    let wasmInfo = {}

    let expectedImports = WebAssembly.Module.imports(module);
    for (const i of expectedImports) {
        if (i.module.startsWith("wasi_")) {
            wasmInfo.wasiVersion = i.module;
        }
    }

    wasmInfo.exportedFuncs = WebAssembly.Module.exports(module).filter(x => x.kind == 'function').map(x => x.name);

    /*
     * Prepare imports
     */

    let imports = {
        // TODO: add ability to define imports
    }

    let wasi;
    let ctx = {};
    if (wasmInfo.wasiVersion)
    {
        const { WASI } = require('wasi');
        wasi = new WASI({
            returnOnExit: true,
            args: argv._,
            env: {
                "NODEJS": 1
            },
            preopens: {
                "/": ".",
                ".": ".",
            }
        });

        if (wasmInfo.wasiVersion == "wasi_snapshot_preview1") {
            imports.wasi_snapshot_preview1 = wasi.wasiImport;
        } else if (wasmInfo.wasiVersion == "wasi_unstable") {
            imports.wasi_unstable = Object.assign({}, wasi.wasiImport);

            const uint8  = r.uint8;
            const uint16 = r.uint16le;
            const uint32 = r.uint32le;
            const uint64 = new r.Struct({ lo: uint32, hi: uint32 });

            const wasi_snapshot_preview1_filestat_t = new r.Struct({
                dev: uint64,   // 0
                ino: uint64,   // 8
                ftype: uint8,  // 16
                pad0:  new r.Reserved(uint8, 7),
                nlink: uint64, // 24
                size: uint64,  // 32
                atim: uint64,  // 40
                mtim: uint64,  // 48
                ctim: uint64   // 56
            }); // size = 64

            const wasi_unstable_filestat_t = new r.Struct({
                dev: uint64,   // 0
                ino: uint64,   // 8
                ftype: uint8,  // 16
                pad0:  new r.Reserved(uint8, 3),
                nlink: uint32, // 20
                size: uint64,  // 24
                atim: uint64,  // 32
                mtim: uint64,  // 40
                ctim: uint64   // 48
            }); // size = 56

            imports.wasi_unstable.fd_seek = function(fd, offset, whence, result) {
                switch (whence) {
                case 0: whence = 1; break;  // cur
                case 1: whence = 2; break;  // end
                case 2: whence = 0; break;  // set
                default: throw "Invalid whence";
                }
                return wasi.wasiImport.fd_seek(fd, offset, whence, result);
            }
            imports.wasi_unstable.fd_filestat_get = function(fd, buf) {
                const mem = new Uint8Array(ctx.memory.buffer);
                const backup = mem.slice(buf+56, buf+(64-56));

                const res = wasi.wasiImport.fd_filestat_get(fd, buf);

                const modified = encodeStruct(wasi_unstable_filestat_t,
                                              decodeStruct(wasi_snapshot_preview1_filestat_t,
                                                           mem.slice(buf, buf+64)));
                mem.set(modified, buf);     // write new struct
                mem.set(backup, buf+56);    // restore backup
                return res;
            }
            imports.wasi_unstable.path_filestat_get = function(fd, flags, path, path_len, buf) {
                const mem = new Uint8Array(ctx.memory.buffer);
                const backup = mem.slice(buf+56, buf+(64-56));

                const res = wasi.wasiImport.path_filestat_get(fd, flags, path, path_len, buf);

                const modified = encodeStruct(wasi_unstable_filestat_t,
                                              decodeStruct(wasi_snapshot_preview1_filestat_t,
                                                           mem.slice(buf, buf+64)));
                mem.set(modified, buf);     // write new struct
                mem.set(backup, buf+56);    // restore backup
                return res;
            }
        } else {
            fatal(`Unsupported WASI version: ${wasmInfo.wasiVersion}`);
        }
    }

    if (argv.trace) {
        function traceGeneric(name, f) {
            return function (...args) {
                try {
                    let res = f.apply(this, args);
                    log(`${name} ${args.join()} => ${res}`);
                    return res;
                } catch (e) {
                    log(`${name} ${args.join()} => ${e}`);
                    throw e;
                }
            }
        }

        let newimports = {}
        for (const [modname, mod] of Object.entries(imports)) {
            newimports[modname] = {}
            for (const [funcname, func] of Object.entries(mod)) {
                newimports[modname][funcname] = traceGeneric(`${modname}!${funcname}`, func);
            }
        }

        imports = newimports;
    }

    /*
     * Execute
     */

    const instance = await WebAssembly.instantiate(module, imports);

    // If no WASI is detected, and no func specified -> try to run the only function
    if (!argv.invoke && !wasmInfo.wasiVersion && wasmInfo.exportedFuncs.length == 1) {
        argv.invoke = wasmInfo.exportedFuncs[0];
    }

    if (argv.invoke) {
        if (!wasmInfo.exportedFuncs.includes(argv.invoke)) {
            fatal(`Function not found: ${argv.invoke}`);
        }
        let args = argv._.slice(1)

        let wasmInfo2 = await parseWasmInfo(binary);
        //console.log(JSON.stringify(wasmInfo2));
        let funcInfo = wasmInfo2.funcsByName[argv.invoke];

        for (let i = 0; i < funcInfo.params.length; i++) {
            switch (funcInfo.params[i]) {
            case 'i32': args[i] = parseInt(args[i]);    break;
            case 'i64': args[i] = BigInt(args[i]);      break;
            case 'f32':
            case 'f64': args[i] = parseFloat(args[i]);  break;
            }
        }

        log(`Running ${argv.invoke}(${args})...`);
        let func = instance.exports[argv.invoke];
        let result = func(...args);
        log(`Result: ${result}`);
    } else {
        ctx.memory = instance.exports.memory;
        let exitcode = wasi.start(instance);
        if (exitcode) {
            log(`Exit code: ${exitcode}`);
        }
        process.exit(exitcode);
    }
})();
