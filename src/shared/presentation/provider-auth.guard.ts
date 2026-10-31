import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (README, seção 2). Não há Identity Provider nesta solução: o guard
 * aceita tudo. Com um IdP, é aqui que o token seria validado e o provider autenticado comparado ao
 * `providerId` da requisição. Aplicado só aos controllers de negócio; o health continua público.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
