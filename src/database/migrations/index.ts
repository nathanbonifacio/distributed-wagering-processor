import { Migration20260101000001_spike } from './Migration20260101000001_spike';
import { Migration20261031000001_drop_spike_wallets } from './Migration20261031000001_drop_spike_wallets';
import { Migration20261031000002_create_wallets } from './Migration20261031000002_create_wallets';
import { Migration20261031000003_create_wager_transactions } from './Migration20261031000003_create_wager_transactions';
import { Migration20261031000004_create_wallet_ledger_entries } from './Migration20261031000004_create_wallet_ledger_entries';
import { Migration20261031000005_create_inbox_messages } from './Migration20261031000005_create_inbox_messages';
import { Migration20261031000006_create_outbox_messages } from './Migration20261031000006_create_outbox_messages';
import { Migration20261031000007_create_integrity_triggers } from './Migration20261031000007_create_integrity_triggers';
import { Migration20261031000008_add_observed_balance_currency } from './Migration20261031000008_add_observed_balance_currency';

/** Lista explícita: o CLI do MikroORM assume ts-node, então registramos as migrations à mão. */
export const migrationsList = [
  { name: 'Migration20260101000001_spike', class: Migration20260101000001_spike },
  { name: 'Migration20261031000001_drop_spike_wallets', class: Migration20261031000001_drop_spike_wallets },
  { name: 'Migration20261031000002_create_wallets', class: Migration20261031000002_create_wallets },
  { name: 'Migration20261031000003_create_wager_transactions', class: Migration20261031000003_create_wager_transactions },
  { name: 'Migration20261031000004_create_wallet_ledger_entries', class: Migration20261031000004_create_wallet_ledger_entries },
  { name: 'Migration20261031000005_create_inbox_messages', class: Migration20261031000005_create_inbox_messages },
  { name: 'Migration20261031000006_create_outbox_messages', class: Migration20261031000006_create_outbox_messages },
  { name: 'Migration20261031000007_create_integrity_triggers', class: Migration20261031000007_create_integrity_triggers },
  { name: 'Migration20261031000008_add_observed_balance_currency', class: Migration20261031000008_add_observed_balance_currency },
];
