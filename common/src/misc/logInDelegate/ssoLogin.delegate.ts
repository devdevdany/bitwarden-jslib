import { LogInDelegate } from "./logIn.delegate";

import { TokenRequestTwoFactor } from "../../models/request/identityToken/tokenRequest";

import { ApiService } from "../../abstractions/api.service";
import { AppIdService } from "../../abstractions/appId.service";
import { CryptoService } from "../../abstractions/crypto.service";
import { LogService } from "../../abstractions/log.service";
import { MessagingService } from "../../abstractions/messaging.service";
import { PlatformUtilsService } from "../../abstractions/platformUtils.service";
import { StateService } from "../../abstractions/state.service";
import { TokenService } from "../../abstractions/token.service";
import { TwoFactorService } from "../../abstractions/twoFactor.service";

import { SsoTokenRequest } from "../../models/request/identityToken/ssoTokenRequest";
import { IdentityTokenResponse } from "../../models/response/identityTokenResponse";
import { KeyConnectorService } from "../../abstractions/keyConnector.service";

export class SsoLogInDelegate extends LogInDelegate {
  tokenRequest: SsoTokenRequest;
  orgId: string;

  constructor(
    cryptoService: CryptoService,
    apiService: ApiService,
    tokenService: TokenService,
    appIdService: AppIdService,
    platformUtilsService: PlatformUtilsService,
    messagingService: MessagingService,
    logService: LogService,
    stateService: StateService,
    setCryptoKeys = true,
    twoFactorService: TwoFactorService,
    private keyConnectorService: KeyConnectorService
  ) {
    super(
      cryptoService,
      apiService,
      tokenService,
      appIdService,
      platformUtilsService,
      messagingService,
      logService,
      stateService,
      twoFactorService,
      setCryptoKeys
    );
  }

  async init(
    code: string,
    codeVerifier: string,
    redirectUrl: string,
    orgId: string,
    twoFactor?: TokenRequestTwoFactor
  ) {
    this.orgId = orgId;
    this.tokenRequest = new SsoTokenRequest(
      code,
      codeVerifier,
      redirectUrl,
      await this.buildTwoFactor(twoFactor),
      await this.buildDeviceRequest()
    );
  }

  async onSuccessfulLogin(tokenResponse: IdentityTokenResponse) {
    const newSsoUser = tokenResponse.key == null;

    if (this.setCryptoKeys && tokenResponse.keyConnectorUrl != null) {
      if (!newSsoUser) {
        await this.keyConnectorService.getAndSetKey(tokenResponse.keyConnectorUrl);
      } else {
        await this.keyConnectorService.convertNewSsoUserToKeyConnector(
          tokenResponse.kdf,
          tokenResponse.kdfIterations,
          tokenResponse.keyConnectorUrl,
          this.orgId
        );
      }
    }
  }

  clearState() {
    this.orgId = null;
    super.clearState();
  }
}