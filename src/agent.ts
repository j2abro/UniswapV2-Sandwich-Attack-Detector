import {
  BlockEvent,
  Finding,
  HandleBlock,
  HandleTransaction,
  TransactionEvent,
  FindingSeverity,
  FindingType,
  getTransactionReceipt,
  getJsonRpcUrl,
  getEthersProvider,
  ethers,
  Receipt
} from "forta-agent";

// Uniswap V2 Arbitrage Attack Detector

const Web3 = require('web3');
const ethers_js = require('ethers');
const ethersProvider = getEthersProvider()
const UniswapPairData = require('./pairs');
const Util = require('./util');
const FlashbotMiners = require('./flashbotMiners');
const transferSig = Util.getTransferEventSignature();
const swapSig = Util.getSwapEventSignature();

// List of all known flashbots minors: Convert to lowercase
const FlashbotMinerAddresses = ['']
for(let i in FlashbotMiners.Addresses){
  FlashbotMinerAddresses.push(FlashbotMiners.Addresses[i].toLowerCase())
}

// Number of blocks to queue before we process block.
//  TX events are async and we might still get events after the next
//  block has started, so we queue up blocks and only process block
//  when they queue is full.
const MAX_BLOCK_QUEUE = 3;

// Frontrunning transactions are in front of block. This limits
//   the analysis to those transactions that are less than this position.
const MAX_POSITION_IN_BLOCK = 15;

// Number of Uniswap V2 trading pairs to include. Max is 5000.
const NUM_TRADING_PAIRS = 5000;

// Print debug to console. This can be pasted into spreadsheet for testing.
const PRINT_CSV_ALL = false; // All blocks together
const PRINT_CSV_PER_BLOCK = false; // Each block with its own header


// Limit number of trading pairs
// console.log(UniswapPairData.Pairs.length)
let uniswapPairs: string[] = [];
for(let i=0; i<NUM_TRADING_PAIRS; i++) {
  let p = UniswapPairData.Pairs[i];
  uniswapPairs.push(p.id)
}

// create map of token symbols keyed by pair address
let pair_token_dict: {[key: string] : any } = {}
for(let i=0; i<NUM_TRADING_PAIRS; i++) {
  let p = UniswapPairData.Pairs[i];
  pair_token_dict[p.id] = {
    'token0' : p.token0.symbol,
    'token1' : p.token1.symbol,
  }
}

// Map of block # to miner addr
let block_miner_dict: {[key: string] : string} = {}

// Store TXs as array and also a dict keyed by block number
let alltxs_debug: object[] = [] //so we can print all TXs
let alltxs_dict: {[key: string] : object[] } = {}

let blocks_to_be_processed: number[] = [];
let last_block_processed = 0;

let findingsCache: Finding[] = [];


function processBlockBoom(txs: Array<any>) {
  let findings: Finding[] = [];
  let findingId = 0;
  let excludeDupliteIndexes = []

  if(!txs) {
    return findings
  }

  txs.sort((a,b) => (a.position > b.position) ? 1 : -1) //Sort by asc position in block

  // Create array of trades: these are the ACTUAL TRADES, and the inverse
  let tradeSummaryArray: string[] = [];
  let tradeSummaryReverseArray: string[] = [];
  // Trades
  for(let i=0; i<txs.length; i++ ) {
    let tx: any = txs[i];
    tradeSummaryArray.push(tx.tradeSummary)
  }
  // Reverse trades
  for(let i=0; i<txs.length; i++ ) {
    let tx: any = txs[i];
    tradeSummaryReverseArray.push(tx.tradeSummaryReverse)
  }

  // ************************************************************
  // LOOP 1: i --> Cycle through each trade
  // ************************************************************
  for(let i=0; i<tradeSummaryArray.length; i++ ) {

    if(i in excludeDupliteIndexes) { continue; }

    let trade_maybe_attack_1: string = tradeSummaryArray[i];

    // If not at end of list, get the next trade
    if(i<(tradeSummaryArray.length-2)) {
      // cycle through rest of items
      // ************************************************************
      // LOOP 2: j --> Cycle through rest of items - find same trade
      // ************************************************************
      for(let j=i+1; j<tradeSummaryArray.length; j++ ) {

        if(j in excludeDupliteIndexes) { continue;}

        let trade_maybe_victim: string = tradeSummaryArray[j];

        if(trade_maybe_attack_1 === trade_maybe_victim) {
          // BINGO: same trade, so lets get full tx from block
          findingId++;
          let tx_attack_1: any = txs[i];
          let tx_victim = txs[j];
          // Add label in the TX record, mostly for debugging
          tx_attack_1.label = 'A1 id=' + findingId;
          tx_victim.label   = 'V id=' + findingId;

          // add these items to exclude list. Don't look at them again
          excludeDupliteIndexes.push(i);
          excludeDupliteIndexes.push(j);

          // lets get the reverse of the item, so get the corresponing reverse trade
          let finalReverseItem: string = tradeSummaryReverseArray[j]; // i & j are the same trade

          // Now we have a match, lets see if there is a backrun trade on the rest of the list
          let found_A2_tx = false;
          if(j<(tradeSummaryArray.length-1)) {
            // ************************************************************
            // LOOP 3: k --> Cycle through rest of items - find REVERSE trade
            // ************************************************************
            for(let k=j+1; k<tradeSummaryArray.length; k++ ) {
              if(k in excludeDupliteIndexes) { continue;}
              let trade_maybe_attack_2: string = tradeSummaryArray[k]; // This is the actual transaction

              if(trade_maybe_attack_2 === finalReverseItem) {
                found_A2_tx = true
                let tx_attack_2: any = txs[k];

                // Compare addresses: We have duplicate trades, but we need to make sure
                let a1_to = tx_attack_1.to
                let a1_from = tx_attack_1.from
                let a2_to = tx_attack_2.to
                let a2_from = tx_attack_2.from

                // If either source address (the bot monitoring the mempool)
                //    of the to address (the MEV contract) is a match
                if(a1_to === a2_to || a1_from === a2_from) {
                  tx_attack_2.label = 'A2 id=' + findingId;;

                  excludeDupliteIndexes.push(k);
                  break; // only find first instance of reverse/A2 trade
                }
              }
            } // end for k (Loop k)

            // If we found A2, it's a sandwich
            let attack_type_msg = found_A2_tx ? 'Sandwich' : 'Frontrunning'

            tx_victim.flashbotMiner
            // If we have fbminer, then this is a flashbot block
            let is_flashbot_miner_msg = tx_victim.flashbotMiner=='' ? 'Yes' : 'No'

            // Finding object
            let f = Finding.fromObject({
              name: 'Uniswap V2 Arbitrage Attack Detected',
              description: `Attack type: ${attack_type_msg}`,
              alertId: 'FORTA-UNISWAP-V2-SANDWICH-1',
              protocol: 'ethereum',
              type: FindingType.Suspicious,
              severity: FindingSeverity.Medium,
              metadata: {
                hash: tx_victim.hash,
                victim: tx_victim.from,
                block: tx_victim.block,
                position: tx_victim.position,
                //minerAddress: tx_victim.miner,
                //isFlashbotBlock: is_flashbot_miner_msg,
                uniswapPair: tx_victim.pairAddress,
                tradeSummary: tx_victim.tradeSummary
              }
            })
            findingsCache.push(f);
          }
          break; // once we have a match, don't keep looping
        }
      }
    }
  }

  // Debug options.
  if(PRINT_CSV_ALL) { Util.printCsvAll(alltxs_debug); }
  // The dict below gets trimmed, see: `delete alltxs_dict...
  if(PRINT_CSV_PER_BLOCK) { Util.printCsvPerBlock(alltxs_dict); }

  return findings;
}


function provideHandleTransaction(
    ethersProvider: ethers.providers.JsonRpcProvider,
    getTransactionReceipt: (txHash: string) => Promise<Receipt>
  ): HandleTransaction {
  return async function handleTransaction(tx: TransactionEvent) {

  const findings: Finding[] = [];

  // ************************************************************
  // Check for blocks to process:
  //    Findings require looking at
  // ************************************************************
  let this_block = tx.blockNumber;

  if (!(blocks_to_be_processed.includes(this_block)) && (this_block > last_block_processed)) {
    blocks_to_be_processed.push(this_block);
  }

  blocks_to_be_processed.sort().reverse(); //lowest blocks at end

  // Queue up a few and take the oldest first
  while(blocks_to_be_processed.length>MAX_BLOCK_QUEUE) {
    let tx_to_process = blocks_to_be_processed.sort().reverse().pop()
    if(tx_to_process) {
      last_block_processed = this_block;
      let txs: Array<any> = alltxs_dict[tx_to_process.toString()];
      // Some blocks have no Uniswap TXs
      if(txs!=undefined) {
        processBlockBoom(txs);
      }
      delete alltxs_dict[tx_to_process.toString()]
    }
  }

  // ************************************************************
  // Add TXs to block
  //    Look at every TX and save relevant attributes with block
  // ************************************************************

  var inputAmount = 0;
  var outputAmount = 0;
  var tokens: string[] = [];
  var tokenAmmounts: any[] = [];

  let hasAddress: boolean = false;
  let pairAddress: string = '';
  for(let addr in tx.addresses) {
    if( uniswapPairs.includes(addr)) {
      hasAddress = true;
      pairAddress = addr;
    }
  }

  if(hasAddress) {
    getTransactionReceipt(tx.hash).then(receipt => {

      if(receipt.transactionIndex > MAX_POSITION_IN_BLOCK) {
        return findings;
      }

      let inputToken = '';
      let outputToken = '';
      let tradeSummary = [];
      let tradeSummaryReverse = [];

      // Util.printSignature(receipt.logs); // debug

      for(let lg in receipt.logs) {
        const log = receipt.logs[lg];
        for(let topic_num in log.topics) {
          const topic = log.topics[topic_num];

          if(topic === transferSig) { // Transfer()
            // Transfer has a single ammount
            const decoded_data = ethers.utils.defaultAbiCoder.decode(['uint256'], log.data)[0].toString();
            tokens.push(log.address);
            tokenAmmounts.push(decoded_data);
          }

          if(topic === swapSig) { // Swap()
            // Get values from data (non-indexed values)
            const decoded_data = ethers.utils.defaultAbiCoder.decode(['uint256','uint256','uint256','uint256'], log.data);

            const amount0In = decoded_data[0];
            const amount1In = decoded_data[1];
            const amount0Out = decoded_data[2];
            const amount1Out = decoded_data[3];

            if (!(log.address in pair_token_dict)) {
              tradeSummary.push('NOPAIR');
              tradeSummaryReverse.unshift('NOPAIR');
              continue;
            }

            if(amount0In.toString() === '0') {
              inputToken = pair_token_dict[log.address].token1 // get address from log, in multi-token transfers each swap will have it's own
            }
            else {
              inputToken = pair_token_dict[log.address].token0
            }
            if(amount0Out.toString() === '0') {
              outputToken = pair_token_dict[log.address].token1
            }
            else {
              outputToken = pair_token_dict[log.address].token0
            }
            // A trading pair can trade in either direction, so save the direction
            tradeSummary.push(inputToken + ' for ' + outputToken);

            // Also save reverse direction as that identifies the backrun sandwich trade
            tradeSummaryReverse.unshift(outputToken + ' for ' + inputToken);

            inputAmount = Math.max(amount0In, amount1In);
            outputAmount = Math.max(amount0Out, amount1Out);
            // const addr1 = ethers.utils.defaultAbiCoder.decode(['address'], log.topics[1])[0]
            // const addr2 = ethers.utils.defaultAbiCoder.decode(['address'], log.topics[2])[0]
          }
        }
      }

      // Gas
      //let gasUsed = Web3.utils.toBN(receipt.gasUsed).toString();
      //let cumulativeGasUsed = Web3.utils.toBN(receipt.cumulativeGasUsed).toString();
      let gasPriceGwei = Web3.utils.fromWei(Web3.utils.toBN(tx.transaction.gasPrice), 'Gwei');
      //let transactionValue = web3.utils.fromWei(Web3.utils.toBN(tx.transaction.value));

      // TODO: Add miner and flashbot addr back in
      // See if current miner address exist in list of flashbots miners
      let flashbotMiner = '';
      let loc = FlashbotMinerAddresses.indexOf(block_miner_dict[tx.blockNumber]);
      if(loc > -1) {
        flashbotMiner = FlashbotMinerAddresses[loc];
      }

      // Trim block dict as we only need recent items. Just keep it longer than
      // For async delays keep a comfortable margin of 20. MAX_BLOCK_QUEUE.
      let block_keys = Object.keys(block_miner_dict).sort().reverse(); //Keys, lowest blocks at end of array

      while(block_keys.length > (MAX_BLOCK_QUEUE + 20)) {
        let block_to_delete = block_keys.pop() // latest block
        // console.log('block_to_delete -->', block_to_delete)
        if(block_to_delete) {
          delete block_miner_dict[block_to_delete]
        }
      }

      // Use any input/output that is weth to get trade amount
      let wethPosition = '';
      let ethEquivAmount = 0;
      const wethAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      for(let i in tokens) {
        if(tokens[i] === wethAddress) {
          wethPosition = i;
          ethEquivAmount = tokenAmmounts[i];
          ethEquivAmount = ethers_js.utils.formatEther(ethEquivAmount);
          break;
        }
      }

      let saveTxObject = {
        label: '',
        block: tx.blockNumber,
        position: receipt.transactionIndex,
        ethEquivAmount: ethEquivAmount,
        gasPriceGwei:  gasPriceGwei,
        miner: block_miner_dict[tx.blockNumber],
        flashbotMiner: flashbotMiner,
        pairAddress: pairAddress,
        tradeSummary: tradeSummary.join('->'),
        tradeSummaryReverse: tradeSummaryReverse.join('->'),
        numTokens: tokens.length,
        numTokenAmounts: tokenAmmounts.length,
        inputAmount: inputAmount,
        outputAmount: outputAmount,
        wethPosition: wethPosition,
        tokens: tokens.join(' '),
        tokenAmmounts: tokenAmmounts.join(' '),
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        contractAddress: receipt.contractAddress
        // addresses: tx.addresses,
        // logAddresses: logAddresses,
        // logAddressesSigs: logAddressesSigs,
        // gasUsed: gasUsed,
        // cumulativeGasUsed: cumulativeGasUsed,
        // transactionValue: transactionValue
        // sigs: sigs.join(' \n ')
      }

      // ************************************************************
      // Save TX to block dict
      //    Add TX to existing or new block
      //    The alltxs_dict items are only removed when processed
      // ************************************************************

      let blockNumber = saveTxObject.block;
      if(blockNumber in alltxs_dict) {
        // exists, so push/append
        let existingArrayOfTxObjects = alltxs_dict[blockNumber];
        existingArrayOfTxObjects.push(saveTxObject);
        alltxs_dict[blockNumber] = existingArrayOfTxObjects;
      }
      else {
        // add new
        let newArrayOfTxObjects = [saveTxObject];
        alltxs_dict[blockNumber] = newArrayOfTxObjects;
      }

      // Debug. This would get large, so don't use in production.
      if(PRINT_CSV_ALL) { alltxs_debug.push(saveTxObject) ; }


    }) //end of .then()
  } // end of if if(hasAddress) {

  return findings;
  };
} // END provideHandleTransaction

// Called for each block. Block is called first, then the TXs.
function provideHandleBlock(): HandleBlock {
  return async function handleBlock(block: BlockEvent) {
    let findings: Finding[] = [];

    if (findingsCache.length > 0) {
      findings = findingsCache;
      findingsCache = [];
    }
    return findings;
  }
}


export default {
  provideHandleBlock,
  handleBlock: provideHandleBlock(),
  provideHandleTransaction,
  handleTransaction: provideHandleTransaction(ethersProvider, getTransactionReceipt)
};
