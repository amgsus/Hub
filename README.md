# Key-value exchange & RPC server (aka Mediator)

## Run standalone

For Node.js 14 and higher:

`node ./app/service.mjs`

For older Node.js versions a key `--experimental-modules` must be added. However, it is not guaranteed that the application will run in older environment properly.

## Command line arguments

| Key | Alias | Mandatory | Description | Example |
| -------- | ----- | --------- | ----------- | ------- |
| `--config <file>` | `-c` | No | Load configuration from file (JSON) | `-c config.json` |  
| `--port <n>` | `-p` | No | Specify network port server listens on | `-p 7778` |  
| `--local` | - | No | Bind the server to local machine host | `--local` |
| `--mirror <ip>[:<port>]` | `-m` | No | Mirror remote instance (receive only). Default port: `7778` | `-m 192.168.0.50:7777` |
| `--preload <file>` | `-d` | No | Preload dictionary with key-values from file (JSON or plain text) | `-d values.json` |
| `--debug` | - | No | Enable detailed output to console | `--debug` |
| `--no-console` | - | No | Suppress all output to console | `--no-console` |
| `--help` | - | No | Print help (no run) | `--help` |

## Configuration

#### Example of configuration file (*.json):

```
{
    "network": {
        "interface": "*",
        "port": 7778
    }
}
```

#### Example of pre-loadable key-value file (*.json):

```
{
    "KeyA": "ValueA",
    "KeyB": "ValueB",
    "KeyC": "ValueC"
}
```

#### Example of pre-loadable key-value file (*.txt):

```
KeyA=ValueA
KeyB=ValueB
KeyC=ValueC
```
