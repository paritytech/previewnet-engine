# Product Preview Network - Zombienet Integration Tests

This directory contains Zombienet integration tests for the multi-chain preview environment.

## Test Files

| File | Description |
| --- | --- |
| `00-network-health.zndsl` | Basic health checks for all nodes |
| `01-asset-hub-revive.zndsl` | Asset Hub pallet-revive tests |
| `02-bulletin-storage.zndsl` | Bulletin Chain transactionStorage tests |
| `03-people-chain.zndsl` | People Chain individuality pallet tests |
| `04-xcm-channels.zndsl` | XCM HRMP channel verification |
| `06-evm-genesis-balances.zndsl` | EVM genesis balance tests |

## Prerequisites

1. **Zombienet CLI** installed ([GitHub](https://github.com/paritytech/zombienet))
2. **Binaries downloaded**: `make fetch`
3. **Chain specs generated**: `make generate`
4. **Node.js 22+** for custom test scripts

## Running Tests Locally

### Run all tests

```bash
bash scripts/run-tests.sh
```

### Run a specific test

```bash
# First, install dependencies
cd tests/scripts && npm install && cd ../..

# Run individual test (BIN must point to the binaries directory)
BIN=$(pwd)/bin zombienet -p native test ./tests/00-network-health.zndsl
BIN=$(pwd)/bin zombienet -p native test ./tests/01-asset-hub-revive.zndsl
BIN=$(pwd)/bin zombienet -p native test ./tests/02-bulletin-storage.zndsl
BIN=$(pwd)/bin zombienet -p native test ./tests/03-people-chain.zndsl
BIN=$(pwd)/bin zombienet -p native test ./tests/04-xcm-channels.zndsl
BIN=$(pwd)/bin zombienet -p native test ./tests/06-evm-genesis-balances.zndsl
```

## Node Reference

| Node Name | Type | WebSocket Port | Parachain ID |
| --------- | ---- | -------------- | ------------ |
| alice-paseo-validator | Relay Validator | 10000 | - |
| bob-paseo-validator | Relay Validator | 10001 | - |
| charlie-paseo-validator | Relay Validator | 10002 | - |
| asset-hub-collator1 | Collator | 10020 | 1500 |
| people-collator1 | Collator | 10010 | 1502 |
| bulletin-collator1 | Collator | 10030 | 1501 |

## Custom JavaScript Tests

Located in `tests/scripts/`:

- **utils.ts** - Shared utilities (connection retry, pallet checks)
- **test-asset-hub-revive.ts** - Tests pallet-revive availability and storage
- **test-bulletin-storage.ts** - Tests transactionStorage pallet and data storage
- **test-people-chain.ts** - Tests individuality/identity pallets
- **test-xcm-channels.ts** - Verifies HRMP channels are open between parachains
- **test-evm-genesis-balances.ts** - Tests EVM genesis balance configuration

### Script Format

All scripts follow Zombienet's custom JS script format:

```javascript
async function run(nodeName, networkInfo, args) {
    const { wsUri, userDefinedTypes } = networkInfo.nodesByName[nodeName];
    // Connect and test
    return 1; // success (or 0 for failure)
}
module.exports = { run };
```

## Adding New Tests

### 1. Create a new ZNDSL file

```zndsl
Description: My New Test
Creds: config

# Basic checks
my-node-name: is up
my-node-name: reports block height is at least 5 within 120 seconds

# Custom JS test
my-node-name: js-script ./scripts/my-test.js return is equal to 1 within 300 seconds
```

### 2. Create custom JS script (if needed)

```javascript
const { connectWithRetry, SUCCESS, FAILURE, safeDisconnect } = require('./utils');

async function run(nodeName, networkInfo, args) {
    let api = null;
    try {
        const { wsUri } = networkInfo.nodesByName[nodeName];
        api = await connectWithRetry(wsUri);
        // Your test logic here
        return SUCCESS;
    } catch (error) {
        console.error(`[TEST] Error: ${error.message}`);
        return FAILURE;
    } finally {
        await safeDisconnect(api);
    }
}

module.exports = { run };
```

## CI Integration

Tests run automatically via `.github/workflows/zombienet-tests.yml`:

- **Triggers**: Push to main, Pull requests to main, Manual dispatch
- **Runner**: parity-large-persistent
- **Timeout**: 90 minutes

### Manual Trigger

You can manually trigger tests from GitHub Actions with an optional specific test file:

1. Go to Actions tab
2. Select "Zombienet Integration Tests"
3. Click "Run workflow"
4. Optionally specify a test file (e.g., `00-network-health.zndsl`)

## Troubleshooting

### Tests timing out

- Increase timeout values in ZNDSL files (`within X seconds`)
- Check if binaries are properly downloaded (`ls -la bin/`)
- Verify chain specs exist (`ls -la bin/*.json`)

### Connection errors in JS scripts

- Ensure the node name matches exactly (e.g., `alice-paseo-validator` not `alice`)
- Check WebSocket port matches `zombienet-configs/local-dev.toml`
- Review `utils.js` retry logic

### Pallet not found errors

- The runtime may not include the expected pallet yet
- Check pallet names in runtime metadata
- Update test script to handle missing pallets gracefully

### View test logs

```bash
# Zombienet logs are typically in /tmp/zombie-*
ls -la /tmp/zombie-*/

# View specific node logs
cat /tmp/zombie-*/alice-paseo-validator.log
```
