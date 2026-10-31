import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { moneySchema, uuidSchema } from '../../../shared/application/contract-schemas';
import { ProviderAuthGuard } from '../../../shared/presentation/provider-auth.guard';
import { parseRequest } from '../../../shared/presentation/request-validation';
import { OpenWallet } from '../application/open-wallet.use-case';

const openWalletSchema = z.strictObject({ playerId: uuidSchema, initialBalance: moneySchema });

/** Separado do WalletController porque a abertura cruza os dois agregados (0001, opção A). */
@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletOpeningController {
  constructor(@Inject(OpenWallet) private readonly openWallet: OpenWallet) {}

  @Post()
  async open(@Body() rawBody: unknown) {
    const wallet = await this.openWallet.execute(parseRequest(openWalletSchema, rawBody));
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
