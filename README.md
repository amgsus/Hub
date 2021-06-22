# Key-value exchange & RPC server (aka Mediator)

## Run standalone

For Node.js 14 and higher:

`node ./app/service.mjs`

For older Node.js versions a key `--experimental-modules` must be added. However, it is not guaranteed that the application will run in older environment properly.

## Command line arguments

| Key | Alias | Mandatory | Description | Example |
| -------- | ----- | --------- | ----------- | ------- |
| `--config <file>` | `-c` | No | Specifies a settings file (JSON). | `-c config.json` |  
| `--port <number>` | `-p` | No | Specifies network port the server listens on. | `-p 7778` |  
| `--local` | `-l` | No | Binds the server to `localhost`. | `--local` |
| `--help` | | No | Prints a help. | `--help` |

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
