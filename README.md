# Sandwich Attack Agent (Uniswap V2)

## Description

Agent to detect sandwich attacks. Attacks are labeled as either a frontrunning or a sandwich attack. 

### Supported Chains

Supports Ethereum main chain.

### How it Works
This agent evaluates each transaction to capture characteristics of a frontrunning or sandwich attack. The results of the analysis of each transaction is stored in a data structure which groups TXs by block. This is required as the TXs need to be ordered for the final analysis (i.e. the front run comes before the victim TX, etc.).

When a block is called the entire list of blocks is evaluated. If both a frontrun and backrun TX are identified, then the alert is labeled a sandwich attack. If only the the front run attack is detected, the alert is defined as a frontrun. The effect on the victim is the same in either case.

## Alerts
Alerts are victim centric. The victim address is highlighted in the transaction.
 - Frontrunning alert when attacker and victim TX are identified
 - Sandwich alert when attacker, victim and backrun TX are identified

## Test Data

**Block 14597944**

This block includes two sets of alerts - both sandwich attacks at position 0,1,2 and 3,4,5 in the block. This should fire two alerts.

`npm run range 14597930..14597960`

# Observations
1. This effort required essentially replicating the Etherscan "Transaction Action" feature that highlights the essential events from the transaction.
2. Most attacks are detected but edge cases exist and could be missed:
  - They are complex (multiswaps) - unusual from my observations for bots, but possible
3. Multiple attacks per block are supported. Sandwiches tend come in 3 consecutive transactions, but a block may include multiple sets for example position 3,4,5 and also 0,1,2. But also may not be the very first set, so just 3,4,5 positions for example. These should be handled as well as sandwiches that are not consecutive positions in block, but if they were not near the front I did not evaluate as this seemed rare, if any, and required evaluating many transactions. For performance, I limited to the first 15 transactions in a block. This number is configurable.
3 Even bots seem to get sandwiched - see these TX hashes.
  0x3aea8b40368276e78db214b7fc09a7af6ab108f5a4d9b0b25bb554e32f7cae3e
  0xf71e9ac1ede664ae73207f8e4e232d446d8c09118302ada796dd53d171de6b38
  0xd991e56395241d443f27f5618b4973951c617622db7373901eb5d2afc9788c6d
And these
  0xac944197e1d1ea44750db16d228bb323c5517282e41edae483e2cc4788378ffc
  0x751dd477da3938f1df632ffa77bd5fb0667ff0229eca42df5de5917ff323cef2
  0xd547e581b6d9f20362455d828a3e119283396fcdac7773113e357a6e44d5e893
4. Gas is not a reliable metric (Flashbots)
 - Attackers are not always using high gas
 - Flashbots gas fees are not necessarily in descending order
 - Some attackers are paying zero gas (private transactions?)
5. Analysis was limited to the first 15 transactions in a block for performance reasons after consistently observing that (as expected) these attacks are typically at the front (this is configurable).

# Research

Creating this agent proved to be a learning experience in DeFi AMMs. My first step was to understnad the mechanics of Uniswap V2 which I documented here: [How to Identify a DeFi Sandwich Attack](https://medium.com/p/ea4208a85b17).

I created the image below to guide the development of this agent:


![Uniswap V2 Image](/assets/images/UniswapV2Frontrunning.png?raw=true)
