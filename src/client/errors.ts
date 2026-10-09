export class ShopError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly remediation: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShopError";
  }
}

export class ContractChangedError extends ShopError {
  constructor(message: string) {
    super(
      message,
      "contract_changed",
      "Ouvrez le site dans Camoufox et vérifiez qu’il fonctionne. Si oui, mettez à jour le connecteur à partir du contrat réellement observé.",
    );
    this.name = "ContractChangedError";
  }
}
