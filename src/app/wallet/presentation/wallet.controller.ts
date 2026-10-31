import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { uuidSchema } from '../../../shared/application/contract-schemas';
import { ProviderAuthGuard } from '../../../shared/presentation/provider-auth.guard';
import { parseRequest } from '../../../shared/presentation/request-validation';
import { WalletQueries } from '../application/wallet-queries';
import type { WalletLedgerEntry } from '../domain/ledger-entry.entity';
import type { Wallet } from '../domain/wallet.entity';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

const LEDGER_PAGE_MAX = 200;
const LEDGER_PAGE_DEFAULT = 50;

const ledgerQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(64).optional(),
  // Só dígitos, sem coerção: "1e3" e "50.5" são inválidos em vez de virarem outro número.
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform(Number)
    .refine((limit) => limit <= LEDGER_PAGE_MAX, `o limite máximo é ${LEDGER_PAGE_MAX}`)
    .optional(),
});

function walletResponse(wallet: Wallet) {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

function ledgerEntryResponse(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

const walletNotFound = () => new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'wallet não encontrada' });

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletController {
  constructor(@Inject(WalletQueries) private readonly queries: WalletQueries) {}

  @Get(':walletId')
  async get(@Param('walletId') rawWalletId: string) {
    const wallet = await this.queries.getWallet(parseRequest(uuidSchema, rawWalletId));
    if (!wallet) throw walletNotFound();
    return walletResponse(wallet);
  }

  /** Keyset por `seq`: novos lançamentos só entram depois do cursor, então nada se repete nem é pulado. */
  @Get(':walletId/ledger')
  async ledger(@Param('walletId') rawWalletId: string, @Query() rawQuery: unknown) {
    const walletId = parseRequest(uuidSchema, rawWalletId);
    const { cursor, limit = LEDGER_PAGE_DEFAULT } = parseRequest(ledgerQuerySchema, rawQuery);
    const afterSeq = cursor === undefined ? undefined : decodeLedgerCursor(cursor);
    if (cursor !== undefined && afterSeq === undefined) {
      throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'cursor inválido' });
    }

    const page = await this.queries.listLedger(walletId, { afterSeq, limit });
    if (!page) throw walletNotFound();
    return {
      entries: page.entries.map(ledgerEntryResponse),
      // Página incompleta é o fim. Página cheia exatamente no fim leva a uma última página vazia.
      nextCursor: page.entries.length === limit && page.lastSeq ? encodeLedgerCursor(page.lastSeq) : null,
    };
  }
}
