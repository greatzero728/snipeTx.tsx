import { networks } from 'bitcoinjs-lib';
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import axios from 'axios';
import { SerializedPsbt } from '@/types/serializedPsbt.type';
import { SERVICE_FEE, FEE_ADDRESS, FEE_ADDRESS_TESTNET } from '@/app.conf';
import { getTxInfo } from '@/api/getInscriptionsFromTx';

type SnipeProps = {
  txid: string;
  inputTxids: string[];
  sign: (psbtBase64: string) => Promise<SerializedPsbt>;
  desiredFee: number;
  buyerOrdinalAddress: string;
  buyerPaymentAddress: string;
  isTestnet: boolean;
};

function getOutputAddress(network: typeof btc.NETWORK, script: Uint8Array) {
  return btc.Address(network).encode(btc.OutScript.decode(script));
}

const getBaseUrl = (isTestnet: boolean) =>
  `https://runeblaster.mempool.space${isTestnet ? '/testnet/api' : '/api'}`;

const fetchTransactionHex = async (txid: string, isTestnet: boolean) => {
  const response = await axios.get(`${getBaseUrl(isTestnet)}/tx/${txid}/hex`);
  return response.data;
};

const fetchUtxos = async (address: string, isTestnet: boolean) => {
  const response = await axios.get(
    `${getBaseUrl(isTestnet)}/address/${address}/utxo`
  );
  return response.data;
};

const getInputByTxid = (tx: btc.Transaction, txid: string) => {
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (!input.txid) {
      throw new Error(`Missing txid for input ${i}`);
    }
    if (hex.encode(input.txid) === txid) {
      return input;
    }
  }
};

// Function to check if the original transaction has RBF enabled
const isRbfEnabled = (originalTx: btc.Transaction) => {
  for (let i = 0; i < originalTx.inputsLength; i++) {
    const input = originalTx.getInput(i);
    if (!input.sequence || (input.sequence && input.sequence >= 0xfffffffe)) {
      return false; // If any input has sequence number >= 0xfffffffe, RBF is not enabled
    }
  }
  return true; // All inputs have sequence number < 0xfffffffe, RBF is enabled
};

export const snipeTransaction = async ({
  txid,
  inputTxids,
  sign,
  desiredFee,
  buyerOrdinalAddress,
  buyerPaymentAddress,
  isTestnet,
}: SnipeProps) => {
  try {
    // @TODO: get rid of this bitcoinjs-lib dependency
    const network = isTestnet ? networks.testnet : networks.bitcoin;
    // @TODO: remake this one to just encode/decode using hex from @scure/base
    const originalTxHex = await fetchTransactionHex(txid, isTestnet);
    const originalTx = btc.Transaction.fromRaw(hex.decode(originalTxHex));

    console.log(inputTxids);
    console.log(originalTx);

    const tx = new btc.Transaction();
    const outputAddresses = new Set();
    let ordinalsTotalPaymentAmount = 0;
    let inputSum = 0n;
    let outputSum = 0n;

    // iterate through only the desired inputs and add them to the transaction
    for (const txid of inputTxids) {
      const input = getInputByTxid(originalTx, txid);
      if (!input) {
        throw new Error(`Input not found for index ${txid}`);
      }
      console.log(input);
      if (!input.txid || input.index === undefined) {
        throw new Error(`Missing txid or index for input ${txid}`);
      }
      const prevTx = await fetchTransactionHex(
        hex.encode(input.txid),
        isTestnet
      );
      const prevTxDecoded = btc.Transaction.fromRaw(hex.decode(prevTx));
      const witnessUtxo = prevTxDecoded.getOutput(input.index);

      if (!witnessUtxo || !witnessUtxo.script || !witnessUtxo.amount) {
        throw new Error(`Missing witness UTXO data for input ${txid}`);
      }

      tx.addInput({
        txid: input.txid,
        index: input.index,
        witnessUtxo: {
          script: witnessUtxo.script,
          amount: witnessUtxo.amount,
        },
      });

      inputSum += witnessUtxo.amount;

      // for each ordinal input, add the buyer's ordinal address as an output
      tx.addOutputAddress(buyerOrdinalAddress, witnessUtxo.amount, network);

      // add seller address to the list of output addresses to iterate through later
      console.log(getOutputAddress(network, witnessUtxo.script));
      outputAddresses.add(getOutputAddress(network, witnessUtxo.script));
    }

    // find desired outputs with seller address and add them to the transaction
    for (let i = 0; i < originalTx.outputsLength; i++) {
      const output = originalTx.getOutput(i);
      if (!output.script || !output.amount) {
        throw new Error(`Missing output data for output ${i}`);
      }

      if (outputAddresses.has(getOutputAddress(network, output.script))) {
        tx.addOutputAddress(
          getOutputAddress(network, output.script),
          output.amount,
          network
        );

        ordinalsTotalPaymentAmount += Number(output.amount);
        outputSum += BigInt(output.amount);
      }
    }

    const fee = Math.ceil(desiredFee);

    // fetch additional UTXOs to cover the fee and service fee
    const additionalUtxos = await fetchUtxos(buyerPaymentAddress, isTestnet);

    const serviceFee = SERVICE_FEE * ordinalsTotalPaymentAmount;

    let additionalValueNeeded = fee + serviceFee + ordinalsTotalPaymentAmount;
    let totalInputValue = 0;

    for (const utxo of additionalUtxos) {
      // @TODO: filter out UTXOs based on inscription rather than value
      if (utxo.value <= 1200) continue;

      const { data: originalUtxoTx } = await getTxInfo(utxo.txid, isTestnet);

      const originalUtxoScript = originalUtxoTx.vout[utxo.vout].scriptpubkey;

      tx.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          amount: BigInt(utxo.value),
          script: hex.decode(originalUtxoScript),
        },
      });
      totalInputValue += utxo.value;
      additionalValueNeeded -= utxo.value;
      inputSum += BigInt(utxo.value);
      if (additionalValueNeeded <= 0) break;
    }

    if (additionalValueNeeded > 0) {
      throw new Error(
        'Insufficient additional UTXOs to cover the fee and service fee'
      );
    }

    if (serviceFee > 0) {
      tx.addOutputAddress(
        isTestnet ? FEE_ADDRESS_TESTNET : FEE_ADDRESS,
        BigInt(Math.ceil(serviceFee)),
        network
      );
      outputSum += BigInt(Math.ceil(serviceFee));
    }

    const changeValue =
      totalInputValue - (fee + serviceFee + ordinalsTotalPaymentAmount);
    if (changeValue > 0) {
      tx.addOutputAddress(
        buyerPaymentAddress,
        BigInt(Math.floor(changeValue)),
        network
      );
      outputSum += BigInt(Math.floor(changeValue));
    }

    outputSum += BigInt(fee);

    console.log(`Total Input Sum: ${inputSum}`);
    console.log(`Total Output Sum: ${outputSum}`);

    const psbt = tx.toPSBT(0);
    const psbtBase64 = base64.encode(psbt);

    const signedTxHex = await sign(psbtBase64);

    const response = await axios.post(
      `${getBaseUrl(isTestnet)}/tx`,
      signedTxHex.hex
    );

    console.log('New transaction broadcasted:', response.data);

    return response.data.txid;
  } catch (error) {
    console.error('Error sniping transaction:', error);
    return undefined;
  }
};
