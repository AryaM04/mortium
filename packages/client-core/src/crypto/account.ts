// The Olm account of this device, held in memory, with its pickle in the
// crypto store. Every change runs in the "account" queue.
import { CryptoStoreError, type CryptoStore } from "./store.js";
import type { KeyedQueue } from "./queue.js";
import type { Wasm } from "./wasm.js";

export const ACCOUNT_QUEUE = "account";
export const ACCOUNT_VALUE = "account";

type Account = InstanceType<Wasm["Account"]>;

export class AccountHolder {
  private constructor(
    readonly account: Account,
    private readonly store: CryptoStore,
    private readonly pickleKey: Uint8Array,
    private readonly queue: KeyedQueue,
  ) {}

  /** Load the account from the store, or make and save a new one. */
  static async load(wasm: Wasm, store: CryptoStore, pickleKey: Uint8Array, queue: KeyedQueue): Promise<AccountHolder> {
    const pickle = await store.getValue<string>(ACCOUNT_VALUE);
    if (pickle) {
      let account: Account;
      try {
        account = wasm.Account.from_pickle(pickle, pickleKey);
      } catch {
        throw new CryptoStoreError("The stored key does not open the local encryption data of this device.");
      }
      return new AccountHolder(account, store, pickleKey, queue);
    }
    const holder = new AccountHolder(new wasm.Account(), store, pickleKey, queue);
    await holder.save();
    return holder;
  }

  get curve25519(): string {
    return this.account.curve25519_key;
  }

  get ed25519(): string {
    return this.account.ed25519_key;
  }

  sign(text: string): string {
    return this.account.sign(text);
  }

  /** The store value that holds the current account state. Put it in the same commit as related changes. */
  pickleValue(): Record<string, string> {
    return { [ACCOUNT_VALUE]: this.account.pickle(this.pickleKey) };
  }

  save(): Promise<void> {
    return this.store.commit({ values: this.pickleValue() });
  }

  /** Run a task that reads or changes the account, after every earlier account task. */
  run<T>(task: (account: Account) => Promise<T>): Promise<T> {
    return this.queue.run(ACCOUNT_QUEUE, () => task(this.account));
  }
}
