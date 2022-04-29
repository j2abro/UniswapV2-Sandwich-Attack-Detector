const ethers = require('ethers');
const fs = require('fs');
const path = require("path");

 function getTransferEventSignature(): string {
  const transfer_event = 'Transfer(address,address,uint256)';
  const transfer_event_bytes = ethers.utils.toUtf8Bytes(transfer_event);
  const transfer_sig = ethers.utils.keccak256(transfer_event_bytes);
  //0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  return(transfer_sig)
}


 function getSwapEventSignature(): string {
  const swap_event = 'Swap(address,uint256,uint256,uint256,uint256,address)';
  const swap_event_bytes = ethers.utils.toUtf8Bytes(swap_event);
  const swap_sig = ethers.utils.keccak256(swap_event_bytes);
  // console.log('swap_sig', swap_sig);
  // 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822') {
  return(swap_sig)
}


const headerLabels = 'label,block,position,ethEquivAmount,gasPriceGwei,currentMinerAddr,flashbotMiner,pairAddress,tradeSummary,tradeSummaryReverse,numTokens,numTokenAmounts,inputAmount,outputAmount,wethPosition,tokens,tokenAmmounts,hash,from,to,contractAddress';

// if(PRINT_CSV_ALL)
function printCsvAll(alltxs: any) {
  console.log('Debug CSV')
  console.log(headerLabels);
  for(let i=0; i<alltxs.length; i++ ) {
    const tx = alltxs[i];
    Object.entries(tx).forEach(([_, value]) => {
        process.stdout.write(value + ',');
        //process.stdout.write(key+ ',')
      }
    );
    console.log('')
  }
}


// if(PRINT_CSV_PER_BLOCK) {
function printCsvPerBlock(alltxs_dict: any) {
  console.log('Debug CSV')
  for(let blockNum in alltxs_dict) {
    console.log(headerLabels);
    let txs = alltxs_dict[blockNum];
    for(let i=0; i<txs.length; i++ ) {
      Object.entries(txs[i]).forEach(([_, value]) => {
          process.stdout.write(value + ',');
        }
      );
      console.log('')
    }
  }
}


// Print out all the signatures. Good for development
// May want to put in main loop of agents.ts to get sig printed next to event
function printSignature(logs: any) {
  for(let lg in logs) {
    const log = logs[lg];
    for(let topic_num in log.topics) {
      const topic = log.topics[topic_num];
      if(topic_num === '0') {
        let sigHash = log.topics[0]
        sigHash = (topic.slice(2)).toLowerCase();
        const sigfile = `./src/topic0/signatures/${sigHash}`; //with_parameter_names signatures
        console.log('sigfile sigfile sigfile', process.cwd())
        try {
          let sig = fs.readFileSync(path.resolve(process.cwd(), sigfile), 'utf-8');
          //Remove trailing newline in PROD. Also remove .join when adding to record
          //sig = sig.replace(/^\s+|\s+$/g, '');
          let pair = log.address.toString() + ' <---> ' + sig.toString();
          console.log('PAIR', pair)
        } catch (e) {
          console.error('READ ERR:', e);
        }
      }
    }
  }
}


module.exports = {
  getTransferEventSignature,
  getSwapEventSignature,
  printCsvAll,
  printCsvPerBlock,
  printSignature
};
