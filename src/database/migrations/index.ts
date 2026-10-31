import { Migration20260101000001_spike } from './Migration20260101000001_spike';

/** Lista explícita: o CLI do MikroORM assume ts-node, então registramos as migrations à mão. */
export const migrationsList = [
  { name: 'Migration20260101000001_spike', class: Migration20260101000001_spike },
];
