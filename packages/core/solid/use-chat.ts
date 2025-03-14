import { Accessor, Resource, Setter, createSignal } from 'solid-js';
import { useSWRStore } from 'solid-swr-store';
import { createSWRStore } from 'swr-store';

import type {
  CreateMessage,
  Message,
  RequestOptions,
  UseChatOptions,
} from '../shared/types';
import { createChunkDecoder, nanoid } from '../shared/utils';

export type { CreateMessage, Message, UseChatOptions };

export type UseChatHelpers = {
  /** Current messages in the chat */
  messages: Resource<Message[]>;
  /** The error object of the API request */
  error: Accessor<undefined | Error>;
  /**
   * Append a user message to the chat list. This triggers the API call to fetch
   * the assistant's response.
   * @param message The message to append
   * @param options Additional options to pass to the API call
   */
  append: (
    message: Message | CreateMessage,
    options?: RequestOptions,
  ) => Promise<string | null | undefined>;
  /**
   * Reload the last AI chat response for the given chat history. If the last
   * message isn't from the assistant, it will request the API to generate a
   * new response.
   */
  reload: (options?: RequestOptions) => Promise<string | null | undefined>;
  /**
   * Abort the current request immediately, keep the generated tokens if any.
   */
  stop: () => void;
  /**
   * Update the `messages` state locally. This is useful when you want to
   * edit the messages on the client, and then trigger the `reload` method
   * manually to regenerate the AI response.
   */
  setMessages: (messages: Message[]) => void;
  /** The current value of the input */
  input: Accessor<string>;
  /** Signal setter to update the input value */
  setInput: Setter<string>;
  /** Form submission handler to automattically reset input and append a user message  */
  handleSubmit: (e: any) => void;
  /** Whether the API request is in progress */
  isLoading: Accessor<boolean>;
};

let uniqueId = 0;

const store: Record<string, Message[] | undefined> = {};
const chatApiStore = createSWRStore<Message[], string[]>({
  get: async (key: string) => {
    return store[key] ?? [];
  },
});

export function useChat({
  api = '/api/chat',
  id,
  initialMessages = [],
  initialInput = '',
  sendExtraMessageFields,
  onResponse,
  onFinish,
  onError,
  credentials,
  headers,
  body,
}: UseChatOptions = {}): UseChatHelpers {
  // Generate a unique ID for the chat if not provided.
  const chatId = id || `chat-${uniqueId++}`;

  const key = `${api}|${chatId}`;
  const data = useSWRStore(chatApiStore, () => [key], {
    initialData: initialMessages,
  });

  const mutate = (data: Message[]) => {
    store[key] = data;
    return chatApiStore.mutate([key], {
      status: 'success',
      data,
    });
  };

  // Because of the `initialData` option, the `data` will never be `undefined`.
  const messages = data as Resource<Message[]>;

  const [error, setError] = createSignal<undefined | Error>(undefined);
  const [isLoading, setIsLoading] = createSignal(false);

  let abortController: AbortController | null = null;
  async function triggerRequest(
    messagesSnapshot: Message[],
    options?: RequestOptions,
  ) {
    try {
      setError(undefined);
      setIsLoading(true);

      abortController = new AbortController();

      // Do an optimistic update to the chat state to show the updated messages
      // immediately.
      const previousMessages = chatApiStore.get([key], {
        shouldRevalidate: false,
      });
      mutate(messagesSnapshot);

      const res = await fetch(api, {
        method: 'POST',
        body: JSON.stringify({
          messages: sendExtraMessageFields
            ? messagesSnapshot
            : messagesSnapshot.map(({ role, content }) => ({
                role,
                content,
              })),
          ...body,
          ...options?.body,
        }),
        headers: {
          ...headers,
          ...options?.headers,
        },
        signal: abortController.signal,
        credentials,
      }).catch(err => {
        // Restore the previous messages if the request fails.
        if (previousMessages.status === 'success') {
          mutate(previousMessages.data);
        }
        throw err;
      });

      if (onResponse) {
        try {
          await onResponse(res);
        } catch (err) {
          throw err;
        }
      }

      if (!res.ok) {
        // Restore the previous messages if the request fails.
        if (previousMessages.status === 'success') {
          mutate(previousMessages.data);
        }
        throw new Error(
          (await res.text()) || 'Failed to fetch the chat response.',
        );
      }
      if (!res.body) {
        throw new Error('The response body is empty.');
      }

      let result = '';
      const createdAt = new Date();
      const replyId = nanoid();
      const reader = res.body.getReader();
      const decoder = createChunkDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        // Update the chat state with the new message tokens.
        result += decoder(value);
        mutate([
          ...messagesSnapshot,
          {
            id: replyId,
            createdAt,
            content: result,
            role: 'assistant',
          },
        ]);

        // The request has been aborted, stop reading the stream.
        if (abortController === null) {
          reader.cancel();
          break;
        }
      }

      if (onFinish) {
        onFinish({
          id: replyId,
          createdAt,
          content: result,
          role: 'assistant',
        });
      }

      abortController = null;
      return result;
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === 'AbortError') {
        abortController = null;
        return null;
      }

      if (onError && err instanceof Error) {
        onError(err);
      }

      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }

  const append: UseChatHelpers['append'] = async (message, options) => {
    if (!message.id) {
      message.id = nanoid();
    }
    return triggerRequest(
      (messages() ?? []).concat(message as Message),
      options,
    );
  };

  const reload: UseChatHelpers['reload'] = async options => {
    const messagesSnapshot = messages();
    if (!messagesSnapshot || messagesSnapshot.length === 0) return null;

    const lastMessage = messagesSnapshot[messagesSnapshot.length - 1];
    if (lastMessage.role === 'assistant') {
      return triggerRequest(messagesSnapshot.slice(0, -1), options);
    }
    return triggerRequest(messagesSnapshot, options);
  };

  const stop = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  };

  const setMessages = (messages: Message[]) => {
    mutate(messages);
  };

  const [input, setInput] = createSignal(initialInput);

  const handleSubmit = (e: any) => {
    e.preventDefault();
    const inputValue = input();
    if (!inputValue) return;
    append({
      content: inputValue,
      role: 'user',
      createdAt: new Date(),
    });
    setInput('');
  };

  return {
    messages,
    append,
    error,
    reload,
    stop,
    setMessages,
    input,
    setInput,
    handleSubmit,
    isLoading,
  };
}
