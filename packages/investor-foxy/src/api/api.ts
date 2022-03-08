import { JsonRpcProvider } from '@ethersproject/providers'
import { ChainReference } from '@shapeshiftoss/caip/dist/caip2/caip2'
import { ChainAdapter } from '@shapeshiftoss/chain-adapters'
import { ChainTypes } from '@shapeshiftoss/types'
import { BigNumber } from 'bignumber.js'
import { toLower } from 'lodash'
import Web3 from 'web3'
import { HttpProvider, TransactionReceipt } from 'web3-core/types'
import { Contract } from 'web3-eth-contract'

import {
  DefiProvider,
  DefiType,
  erc20Abi,
  foxyAbi,
  foxyStakingContractAddress,
  MAX_ALLOWANCE
} from '../constants'
import { bnOrZero, buildTxToSign } from '../utils'
import {
  Allowanceinput,
  ApproveInput,
  BalanceInput,
  EstimateGasApproveInput,
  EstimateGasTxInput,
  TVLInput,
  TxInput
} from './foxy-types'

export type ConstructorArgs = {
  adapter: ChainAdapter<ChainTypes.Ethereum>
  providerUrl: string
  network?:
    | ChainReference.EthereumMainnet
    | ChainReference.EthereumRinkeby
    | ChainReference.EthereumRopsten
}

export const transformVault = (vault: any): any => {
  return {
    ...vault,
    vaultAddress: toLower(vault.address),
    name: `${vault.name} ${vault.version}`,
    symbol: vault.symbol,
    tokenAddress: toLower(vault.token),
    chain: ChainTypes.Ethereum,
    provider: DefiProvider.Foxy,
    type: DefiType.TokenStaking,
    expired: vault.metadata.depositsDisabled || bnOrZero(vault.metadata.depositLimit).lte(0)
  }
}

export class FoxyApi {
  public adapter: ChainAdapter<ChainTypes.Ethereum>
  public provider: HttpProvider
  public jsonRpcProvider: JsonRpcProvider
  public web3: Web3
  private foxyStakingContracts: Contract[]

  constructor({ adapter, providerUrl }: ConstructorArgs) {
    this.adapter = adapter
    this.provider = new Web3.providers.HttpProvider(providerUrl)
    this.jsonRpcProvider = new JsonRpcProvider(providerUrl)
    this.web3 = new Web3(this.provider)
    this.foxyStakingContracts = [new this.web3.eth.Contract(foxyAbi, foxyStakingContractAddress)]
  }

  findDataByContractAddress(contractAddress: string) {
    const stakingContract = this.foxyStakingContracts.find(
      (item) => toLower(item.options.address) === toLower(contractAddress)
    )
    if (!stakingContract) return null
    return stakingContract // transformVault(vault)
  }

  async getGasPrice() {
    const gasPrice = await this.web3.eth.getGasPrice()
    return bnOrZero(gasPrice)
  }

  async getTxReceipt({ txid }: { txid: string }): Promise<TransactionReceipt> {
    return await this.web3.eth.getTransactionReceipt(txid)
  }

  checksumAddress(address: string): string {
    return this.web3.utils.toChecksumAddress(address)
  }

  async estimateWithdrawGas(input: EstimateGasTxInput): Promise<BigNumber> {
    const { amountDesired, userAddress, contractAddress } = input
    const stakingContract = this.foxyStakingContracts.find(
      (item) => toLower(item.options.address) === toLower(contractAddress)
    )
    if (!stakingContract) throw new Error('Not a valid contract address')
    console.log('amountDesired', amountDesired)
    const estimatedGas = await stakingContract.methods
      .unstake(amountDesired.toString(), true)
      .estimateGas({
        from: userAddress
      })
    return bnOrZero(estimatedGas)
  }

  async estimateInstantWithdrawGas(
    input: Pick<EstimateGasTxInput, Exclude<keyof EstimateGasTxInput, 'amountDesired'>>
  ): Promise<BigNumber> {
    const { userAddress, contractAddress } = input
    const stakingContract = this.foxyStakingContracts.find(
      (item) => toLower(item.options.address) === toLower(contractAddress)
    )
    if (!stakingContract) throw new Error('Not a valid contract address')
    const estimatedGas = await stakingContract.methods.instantUnstake(true).estimateGas({
      from: userAddress
    })
    return bnOrZero(estimatedGas)
  }

  async estimateDepositGas(input: EstimateGasTxInput): Promise<BigNumber> {
    const { amountDesired, userAddress, contractAddress, tokenContractAddress } = input
    const stakingContract = this.foxyStakingContracts.find(
      (item) => toLower(item.options.address) === toLower(contractAddress)
    )
    if (!stakingContract) throw new Error('Not a valid contract address')
    if (!tokenContractAddress) throw new Error('Not a valid contract address')
    const estimatedGas = await stakingContract.methods
      .stake(amountDesired.toString(), userAddress)
      .estimateGas({
        from: userAddress
      })
    return bnOrZero(estimatedGas)
  }

  async estimateApproveGas(input: EstimateGasApproveInput): Promise<BigNumber> {
    const { userAddress, tokenContractAddress, contractAddress } = input
    const depositTokenContract = new this.web3.eth.Contract(erc20Abi, tokenContractAddress)
    const estimatedGas = await depositTokenContract.methods
      .approve(contractAddress, MAX_ALLOWANCE)
      .estimateGas({
        from: userAddress
      })
    return bnOrZero(estimatedGas)
  }

  async approve(input: ApproveInput): Promise<string> {
    const {
      accountNumber = 0,
      dryRun = false,
      tokenContractAddress,
      userAddress,
      wallet,
      contractAddress
    } = input
    if (!wallet) throw new Error('Missing inputs')
    const estimatedGas: BigNumber = await this.estimateApproveGas(input)
    const depositTokenContract = new this.web3.eth.Contract(erc20Abi, tokenContractAddress)
    const data: string = depositTokenContract.methods
      .approve(contractAddress, MAX_ALLOWANCE)
      .encodeABI({
        from: userAddress
      })
    const nonce: number = await this.web3.eth.getTransactionCount(userAddress)
    const gasPrice: string = await this.web3.eth.getGasPrice()

    const txToSign = buildTxToSign({
      bip44Params: this.adapter.buildBIP44Params({ accountNumber }),
      chainId: 1,
      data,
      estimatedGas: estimatedGas.toString(),
      gasPrice,
      nonce: String(nonce),
      to: tokenContractAddress,
      value: '0'
    })
    if (wallet.supportsOfflineSigning()) {
      const signedTx = await this.adapter.signTransaction({ txToSign, wallet })
      if (dryRun) return signedTx
      // TODO: change back to broadcastTransaction
      //return this.adapter.broadcastTransaction(signedTx)
      const sendSignedTx = await this.web3.eth.sendSignedTransaction(signedTx)
      return sendSignedTx?.blockHash
    } else if (wallet.supportsBroadcast() && this.adapter.signAndBroadcastTransaction) {
      if (dryRun) {
        throw new Error(`Cannot perform a dry run with wallet of type ${wallet.getVendor()}`)
      }
      return this.adapter.signAndBroadcastTransaction({ txToSign, wallet })
    } else {
      throw new Error('Invalid HDWallet configuration ')
    }
  }

  async allowance(input: Allowanceinput): Promise<string> {
    const { userAddress, tokenContractAddress } = input
    const depositTokenContract: Contract = new this.web3.eth.Contract(
      erc20Abi,
      tokenContractAddress
    )
    return depositTokenContract.methods.allowance(userAddress, foxyStakingContractAddress).call()
  }

  async deposit(input: TxInput): Promise<string> {
    const {
      amountDesired,
      accountNumber = 0,
      dryRun = false,
      contractAddress,
      tokenContractAddress,
      userAddress,
      wallet
    } = input
    if (!wallet || !contractAddress) throw new Error('Missing inputs')
    const estimatedGas: BigNumber = await this.estimateDepositGas(input)
    const stakingContract = this.foxyStakingContracts.find(
      (item) => toLower(item.options.address) === toLower(contractAddress)
    )
    if (!stakingContract) throw new Error('Not a valid contract address')
    const userChecksum = this.web3.utils.toChecksumAddress(userAddress)

    const data: string = await stakingContract.methods
      .stake(amountDesired.toString(), userAddress)
      .encodeABI({
        value: 0,
        from: userChecksum
      })
    const nonce = await this.web3.eth.getTransactionCount(userAddress)
    const gasPrice = await this.web3.eth.getGasPrice()

    const txToSign = buildTxToSign({
      bip44Params: this.adapter.buildBIP44Params({ accountNumber }),
      chainId: 1,
      data,
      estimatedGas: estimatedGas.toString(),
      gasPrice,
      nonce: String(nonce),
      to: foxyStakingContractAddress,
      value: '0'
    })
    if (wallet.supportsOfflineSigning()) {
      const signedTx = await this.adapter.signTransaction({ txToSign, wallet })
      if (dryRun) return signedTx
      // TODO: change back to broadcastTransaction
      //return this.adapter.broadcastTransaction(signedTx)
      const sendSignedTx = await this.web3.eth.sendSignedTransaction(signedTx)
      return sendSignedTx?.blockHash
    } else if (wallet.supportsBroadcast() && this.adapter.signAndBroadcastTransaction) {
      if (dryRun) {
        throw new Error(`Cannot perform a dry run with wallet of type ${wallet.getVendor()}`)
      }
      return this.adapter.signAndBroadcastTransaction({ txToSign, wallet })
    } else {
      throw new Error('Invalid HDWallet configuration ')
    }
  }

  async withdraw(input: TxInput): Promise<string> {
    const {
      amountDesired,
      accountNumber = 0,
      dryRun = false,
      contractAddress,
      userAddress,
      wallet
    } = input
    if (!wallet || !contractAddress) throw new Error('Missing inputs')
    const estimatedGas: BigNumber = await this.estimateWithdrawGas(input)
    const stakingContract = this.foxyStakingContracts.find(
      (item) => toLower(item.options.address) === toLower(contractAddress)
    )
    if (!stakingContract) throw new Error('Not a valid contract address')
    console.log('estimatedGas', estimatedGas)
    const data: string = stakingContract.methods.unstake(amountDesired.toString(), true).encodeABI({
      from: userAddress
    })
    const nonce = await this.web3.eth.getTransactionCount(userAddress)
    const gasPrice = await this.web3.eth.getGasPrice()
    const txToSign = buildTxToSign({
      bip44Params: this.adapter.buildBIP44Params({ accountNumber }),
      chainId: 1,
      data,
      estimatedGas: estimatedGas.toString(),
      gasPrice,
      nonce: String(nonce),
      to: foxyStakingContractAddress,
      value: '0'
    })
    if (wallet.supportsOfflineSigning()) {
      const signedTx = await this.adapter.signTransaction({ txToSign, wallet })
      if (dryRun) return signedTx
      // TODO: change back to broadcastTransaction
      //return this.adapter.broadcastTransaction(signedTx)
      const sendSignedTx = await this.web3.eth.sendSignedTransaction(signedTx)
      return sendSignedTx?.blockHash
    } else if (wallet.supportsBroadcast() && this.adapter.signAndBroadcastTransaction) {
      if (dryRun) {
        throw new Error(`Cannot perform a dry run with wallet of type ${wallet.getVendor()}`)
      }
      return this.adapter.signAndBroadcastTransaction({ txToSign, wallet })
    } else {
      throw new Error('Invalid HDWallet configuration ')
    }
  }

  async instantWithdraw(
    input: Pick<TxInput, Exclude<keyof TxInput, 'amountDesired'>>
  ): Promise<string> {
    const { accountNumber = 0, dryRun = false, contractAddress, userAddress, wallet } = input
    if (!wallet || !contractAddress) throw new Error('Missing inputs')
    const estimatedGas: BigNumber = await this.estimateInstantWithdrawGas(input)
    const stakingContract = this.foxyStakingContracts.find(
      (item) => toLower(item.options.address) === toLower(contractAddress)
    )
    if (!stakingContract) throw new Error('Not a valid contract address')

    const data: string = stakingContract.methods.instantUnstake(true).encodeABI({
      from: userAddress
    })
    const nonce = await this.web3.eth.getTransactionCount(userAddress)
    const gasPrice = await this.web3.eth.getGasPrice()
    console.log('estimatedGas', estimatedGas)
    const txToSign = buildTxToSign({
      bip44Params: this.adapter.buildBIP44Params({ accountNumber }),
      chainId: 1,
      data,
      estimatedGas: estimatedGas.toString(),
      gasPrice,
      nonce: String(nonce),
      to: foxyStakingContractAddress,
      value: '0'
    })
    if (wallet.supportsOfflineSigning()) {
      const signedTx = await this.adapter.signTransaction({ txToSign, wallet })
      if (dryRun) return signedTx
      // TODO: change back to broadcastTransaction
      //return this.adapter.broadcastTransaction(signedTx)
      const sendSignedTx = await this.web3.eth.sendSignedTransaction(signedTx)
      return sendSignedTx?.blockHash
    } else if (wallet.supportsBroadcast() && this.adapter.signAndBroadcastTransaction) {
      if (dryRun) {
        throw new Error(`Cannot perform a dry run with wallet of type ${wallet.getVendor()}`)
      }
      return this.adapter.signAndBroadcastTransaction({ txToSign, wallet })
    } else {
      throw new Error('Invalid HDWallet configuration ')
    }
  }

  // async claimWithdraw(
  //   input: Pick<TxInput, Exclude<keyof TxInput, 'amountDesired'>>
  // ): Promise<string> {
  //   const { accountNumber = 0, dryRun = false, contractAddress, userAddress, wallet } = input
  //   if (!wallet || !contractAddress) throw new Error('Missing inputs')
  //   const estimatedGas: BigNumber = await this.estimateInstantWithdrawGas(input)
  //   const stakingContract = this.foxyStakingContracts.find(
  //     (item) => toLower(item.options.address) === toLower(contractAddress)
  //   )
  //   if (!stakingContract) throw new Error('Not a valid contract address')

  //   const data: string = stakingContract.methods.instantUnstake(true).encodeABI({
  //     from: userAddress
  //   })
  //   const nonce = await this.web3.eth.getTransactionCount(userAddress)
  //   const gasPrice = await this.web3.eth.getGasPrice()

  //   const txToSign = buildTxToSign({
  //     bip44Params: this.adapter.buildBIP44Params({ accountNumber }),
  //     chainId: 1,
  //     data,
  //     estimatedGas: estimatedGas.toString(),
  //     gasPrice,
  //     nonce: String(nonce),
  //     to: foxyStakingContractAddress,
  //     value: '0'
  //   })
  //   if (wallet.supportsOfflineSigning()) {
  //     const signedTx = await this.adapter.signTransaction({ txToSign, wallet })
  //     if (dryRun) return signedTx
  //     // TODO: change back to broadcastTransaction
  //     //return this.adapter.broadcastTransaction(signedTx)
  //     const sendSignedTx = await this.web3.eth.sendSignedTransaction(signedTx)
  //     return sendSignedTx?.blockHash
  //   } else if (wallet.supportsBroadcast() && this.adapter.signAndBroadcastTransaction) {
  //     if (dryRun) {
  //       throw new Error(`Cannot perform a dry run with wallet of type ${wallet.getVendor()}`)
  //     }
  //     return this.adapter.signAndBroadcastTransaction({ txToSign, wallet })
  //   } else {
  //     throw new Error('Invalid HDWallet configuration ')
  //   }
  // }

  async balance(input: BalanceInput): Promise<BigNumber> {
    const { tokenContractAddress, userAddress } = input
    const contract = new this.web3.eth.Contract(erc20Abi, tokenContractAddress)
    const balance = await contract.methods.balanceOf(userAddress).call()
    return bnOrZero(balance)
  }

  async totalSupply({
    tokenContractAddress
  }: {
    tokenContractAddress: string
  }): Promise<BigNumber> {
    const contract = new this.web3.eth.Contract(erc20Abi, tokenContractAddress)
    const totalSupply = await contract.methods.totalSupply().call()
    return bnOrZero(totalSupply)
  }

  // estimated apy
  async apy(): Promise<string> {
    return '.2'
  }

  async tvl(input: TVLInput): Promise<BigNumber> {
    const { tokenContractAddress } = input
    const contract = new this.web3.eth.Contract(erc20Abi, tokenContractAddress)
    const balance = await contract.methods.circulatingSupply().call()
    return bnOrZero(balance)
  }
}