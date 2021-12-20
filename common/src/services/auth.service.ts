import { HashPurpose } from "../enums/hashPurpose";
import { KdfType } from "../enums/kdfType";
import { TwoFactorProviderType } from "../enums/twoFactorProviderType";

import { AccountProfile, AccountTokens } from "../models/domain/account";
import { AuthResult } from "../models/domain/authResult";
import { SymmetricCryptoKey } from "../models/domain/symmetricCryptoKey";

import { DeviceRequest } from "../models/request/deviceRequest";
import { KeysRequest } from "../models/request/keysRequest";
import { PreloginRequest } from "../models/request/preloginRequest";

import { ApiTokenRequest } from "../models/request/identityToken/apiTokenRequest";
import { PasswordTokenRequest } from "../models/request/identityToken/passwordTokenRequest";
import { SsoTokenRequest } from "../models/request/identityToken/ssoTokenRequest";
import { TwoFactorData } from "../models/request/identityToken/tokenRequest";

import { IdentityTokenResponse } from "../models/response/identityTokenResponse";
import { IdentityTwoFactorResponse } from "../models/response/identityTwoFactorResponse";

import { ApiService } from "../abstractions/api.service";
import { AppIdService } from "../abstractions/appId.service";
import { AuthService as AuthServiceAbstraction } from "../abstractions/auth.service";
import { CryptoService } from "../abstractions/crypto.service";
import { EnvironmentService } from "../abstractions/environment.service";
import { KeyConnectorService } from "../abstractions/keyConnector.service";
import { LogService } from "../abstractions/log.service";
import { MessagingService } from "../abstractions/messaging.service";
import { PlatformUtilsService } from "../abstractions/platformUtils.service";
import { StateService } from "../abstractions/state.service";
import { TokenService } from "../abstractions/token.service";

import { TwoFactorService } from "../abstractions/twoFactor.service";
import { IdentityCaptchaResponse } from "../models/response/identityCaptchaResponse";

export class AuthService implements AuthServiceAbstraction {
  private savedTokenRequest: ApiTokenRequest | PasswordTokenRequest | SsoTokenRequest;
  private localHashedPassword: string;
  private key: SymmetricCryptoKey;

  constructor(
    private cryptoService: CryptoService,
    protected apiService: ApiService,
    protected tokenService: TokenService,
    protected appIdService: AppIdService,
    protected platformUtilsService: PlatformUtilsService,
    private messagingService: MessagingService,
    private logService: LogService,
    private keyConnectorService: KeyConnectorService,
    protected environmentService: EnvironmentService,
    protected stateService: StateService,
    private twoFactorService: TwoFactorService,
    private setCryptoKeys = true
  ) {}

  async logIn(
    email: string,
    masterPassword: string,
    twoFactor?: TwoFactorData,
    captchaToken?: string
  ): Promise<AuthResult> {
    this.twoFactorService.clearSelectedProvider();

    let tokenRequest: PasswordTokenRequest;
    let key: SymmetricCryptoKey;
    let localHashedPassword: string;

    if (this.savedTokenRequest != null) {
      tokenRequest = this.savedTokenRequest as PasswordTokenRequest;
      key = this.key;
      localHashedPassword = this.localHashedPassword;
    } else {
      key = await this.makePreloginKey(masterPassword, email);
      localHashedPassword = await this.cryptoService.hashPassword(
        masterPassword,
        key,
        HashPurpose.LocalAuthorization
      );
      const hashedPassword = await this.cryptoService.hashPassword(masterPassword, key);
      tokenRequest = new PasswordTokenRequest(
        email,
        hashedPassword,
        captchaToken,
        await this.createTwoFactorData(twoFactor),
        await this.createDeviceRequest()
      );
    } 

    const response = await this.apiService.postIdentityToken(tokenRequest);

    const successCallback = async () => {
      if (this.setCryptoKeys) {
        await this.cryptoService.setKey(key);
        await this.cryptoService.setKeyHash(localHashedPassword);
      }
    }
    const result = await this.processTokenResponse(response, false, successCallback);

    if (result.requiresTwoFactor) {
      this.saveState(tokenRequest, result.twoFactorProviders, localHashedPassword, key);
    }

    return result;
  }

  async logInSso(
    code: string,
    codeVerifier: string,
    redirectUrl: string,
    orgId: string,
    twoFactor?: TwoFactorData
  ): Promise<AuthResult> {
    this.twoFactorService.clearSelectedProvider();

    const tokenRequest = this.savedTokenRequest ?? new SsoTokenRequest(
      code,
      codeVerifier,
      redirectUrl,
      await this.createTwoFactorData(twoFactor),
      await this.createDeviceRequest()
    );

    const response = await this.apiService.postIdentityToken(tokenRequest);
    const tokenResponse = response as IdentityTokenResponse;

    const newSsoUser = tokenResponse.key == null;
    const successCallback = async () => {
      if (this.setCryptoKeys && tokenResponse.keyConnectorUrl != null) {
        if (!newSsoUser) {
          await this.keyConnectorService.getAndSetKey(tokenResponse.keyConnectorUrl);
        } else {
          await this.keyConnectorService.convertNewSsoUserToKeyConnector(
            tokenResponse.kdf,
            tokenResponse.kdfIterations,
            tokenResponse.keyConnectorUrl,
            orgId
          );
        }
      }
    }

    const result = await this.processTokenResponse(response, newSsoUser, successCallback);

    if (result.requiresTwoFactor) {
      this.saveState(tokenRequest, result.twoFactorProviders);
    }

    return result;
  }

  async logInApiKey(
    clientId: string,
    clientSecret: string,
    twoFactor?: TwoFactorData
  ): Promise<AuthResult> {
    this.twoFactorService.clearSelectedProvider();

    const tokenRequest = this.savedTokenRequest ?? new ApiTokenRequest(
      clientId,
      clientSecret,
      await this.createTwoFactorData(twoFactor),
      await this.createDeviceRequest()
    );

    const response = await this.apiService.postIdentityToken(tokenRequest);

    const successCallback = async () => {
      await this.stateService.setApiKeyClientId(clientId);
      await this.stateService.setApiKeyClientSecret(clientSecret);

      const tokenResponse = response as IdentityTokenResponse;
      if (tokenResponse.apiUseKeyConnector) {
        const keyConnectorUrl = this.environmentService.getKeyConnectorUrl();
        await this.keyConnectorService.getAndSetKey(keyConnectorUrl);
      }
    }

    const result = await this.processTokenResponse(response, false, successCallback);

    if (result.requiresTwoFactor) {
      this.saveState(tokenRequest, result.twoFactorProviders);
    }

    return result;
  }

  async logInTwoFactor(twoFactor: TwoFactorData): Promise<AuthResult> {
    this.savedTokenRequest.setTwoFactor(twoFactor);

    if (this.authingWithPassword) {
      return await this.logIn(null, null);
    }

    if (this.authingWithApiKey) {
      return await this.logInApiKey(null, null);
    }

    if (this.authingWithSso) {
      return await this.logInSso(null, null, null, null);
    }

    throw new Error("Error: Could not find stored login state.");
  }

  logOut(callback: Function) {
    callback();
    this.messagingService.send("loggedOut");
  }

  authingWithApiKey(): boolean {
    return this.savedTokenRequest instanceof ApiTokenRequest;
  }

  authingWithSso(): boolean {
    return this.savedTokenRequest instanceof SsoTokenRequest;
  }

  authingWithPassword(): boolean {
    return this.savedTokenRequest instanceof PasswordTokenRequest;
  }

  async makePreloginKey(masterPassword: string, email: string): Promise<SymmetricCryptoKey> {
    email = email.trim().toLowerCase();
    let kdf: KdfType = null;
    let kdfIterations: number = null;
    try {
      const preloginResponse = await this.apiService.postPrelogin(new PreloginRequest(email));
      if (preloginResponse != null) {
        kdf = preloginResponse.kdf;
        kdfIterations = preloginResponse.kdfIterations;
      }
    } catch (e) {
      if (e == null || e.statusCode !== 404) {
        throw e;
      }
    }
    return this.cryptoService.makeKey(masterPassword, email, kdf, kdfIterations);
  }

  private async processTokenResponse(
    response: IdentityTokenResponse | IdentityTwoFactorResponse | IdentityCaptchaResponse,
    newSsoUser: boolean = false,
    successCallback: () => any
  ): Promise<AuthResult> {
    this.clearState();
    const result = new AuthResult();

    result.captchaSiteKey = (response as IdentityCaptchaResponse).siteKey;
    if (result.requiresCaptcha) {
      return result;
    }

    result.twoFactorProviders = (response as IdentityTwoFactorResponse).twoFactorProviders2;
    if (result.requiresTwoFactor) {
      return result;
    }

    const tokenResponse = response as IdentityTokenResponse;
    result.resetMasterPassword = tokenResponse.resetMasterPassword;
    result.forcePasswordReset = tokenResponse.forcePasswordReset;

    this.saveAccountInformation(tokenResponse);

    if (tokenResponse.twoFactorToken != null) {
      await this.tokenService.setTwoFactorToken(tokenResponse.twoFactorToken);
    }

    if (this.setCryptoKeys && !newSsoUser) {
      await this.cryptoService.setEncKey(tokenResponse.key);

      // User doesn't have a key pair yet (old account), let's generate one for them
      if (tokenResponse.privateKey == null) {
        const newKeyPair = await this.createKeyPair();
        await this.cryptoService.setEncPrivateKey(newKeyPair);
      } else {
        await this.cryptoService.setEncPrivateKey(tokenResponse.privateKey);
      }
    }

    await successCallback();

    await this.stateService.setBiometricLocked(false);
    this.messagingService.send("loggedIn");

    return result;
  }

  private async createDeviceRequest() {
    const appId = await this.appIdService.getAppId();
    return new DeviceRequest(appId, this.platformUtilsService);
  }

  private async createTwoFactorData(twoFactor: TwoFactorData) {
    if (twoFactor == null) {
      const storedTwoFactorToken = await this.tokenService.getTwoFactorToken();
      if (storedTwoFactorToken != null) {
        twoFactor = {
          token: storedTwoFactorToken,
          provider: TwoFactorProviderType.Remember,
          remember: false,
        };
      } else {
        twoFactor = {
          token: null,
          provider: null,
          remember: false,
        };
      }
    }
    return twoFactor;
  }

  private async saveAccountInformation(tokenResponse: IdentityTokenResponse) {
    const accountInformation = await this.tokenService.decodeToken(tokenResponse.accessToken);
    await this.stateService.addAccount({
      profile: {
        ...new AccountProfile(),
        ...{
          userId: accountInformation.sub,
          email: accountInformation.email,
          hasPremiumPersonally: accountInformation.premium,
          kdfIterations: tokenResponse.kdfIterations,
          kdfType: tokenResponse.kdf,
        },
      },
      tokens: {
        ...new AccountTokens(),
        ...{
          accessToken: tokenResponse.accessToken,
          refreshToken: tokenResponse.refreshToken,
        },
      },
    });
  }

  private async createKeyPair() {
    try {
      const keyPair = await this.cryptoService.makeKeyPair();
      await this.apiService.postAccountKeys(
        new KeysRequest(keyPair[0], keyPair[1].encryptedString)
      );
      return keyPair[1].encryptedString;
    } catch (e) {
      this.logService.error(e);
    }
  }

  private saveState(
    tokenRequest: ApiTokenRequest | PasswordTokenRequest | SsoTokenRequest,
    twoFactorProviders: Map<TwoFactorProviderType, { [key: string]: string }>,
    localhashedPassword?: string,
    key?: SymmetricCryptoKey
  ) {
    this.savedTokenRequest = tokenRequest;
    this.twoFactorService.setProviders(twoFactorProviders);

    this.localHashedPassword = localhashedPassword;
    this.key = key;
  }

  private clearState(): void {
    this.savedTokenRequest = null;
    this.twoFactorService.clearProviders();
    this.twoFactorService.clearSelectedProvider();

    this.localHashedPassword = null;
    this.key = null;
  }
}
