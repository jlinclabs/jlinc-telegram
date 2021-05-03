'use strict';

const { MTProto } = require('@mtproto/core');
const delay = require('delay');
const {
  addUsersToMessages,
  getFormedMessagesFromUpdates,
} = require('./helpers');

module.exports = class TelegramClient {
  constructor({ apiId, apiHash, test }) {
    this.apiID = apiId;
    this.apiHash = apiHash;
    this.test = test;
    this.channelMessageSubscribers = {};
  }

  async connect(authKeys) {
    if (this.client) {
      if (authKeys) this.client.importAuthKeys(authKeys);
      return;
    }

    const initialSocketConnection = { connected: false };

    return new Promise((resolve) => {
      const onSocketOpen = updates => () => {
        updates.on('updates', ({ updates, users }) => {
          const messages = getFormedMessagesFromUpdates({ updates, users });
          const messagesByChannelId = {};
          Object.values(messages).forEach(message => {
            const channelId = message.channelId;
            messagesByChannelId[channelId] = {
              ...messagesByChannelId[channelId],
              [message.id]: message,
            };
          });
          for (const channelId in messagesByChannelId) {
            if (this.channelMessageSubscribers[channelId])
              this.channelMessageSubscribers[channelId](messagesByChannelId[channelId]);
          }
        });

        if (!initialSocketConnection.connected) {
          initialSocketConnection.connected = true;
          resolve();
        }
      };

      const onSocketError = () => {
        if (!initialSocketConnection.connected) {
          reject();
        }
      };

      this.client = new MTProto({
        api_id: this.apiID,
        api_hash: this.apiHash,
        test: this.test,
        authKeys,
        onSocketOpen,
        onSocketError,
      });
    });
  }

  disconnect() {
    if (!this.client) return;

    Object.values(this.client.rpcs).forEach(({ transport }) => {
      transport.emit('close');
    });

    delete this.client;
  }

  disconnectIfIdle() {
    if (Object.keys(this.channelMessageSubscribers).length === 0) this.disconnect();
  }

  isConnected() {
    return !!this.client;
  }

  importAuthKeys(authKeys) {
    this.client.importAuthKeys(authKeys);
  }

  getAuthKeys() {
    return this.client.getAuthKeys();
  }

  subscribeToChannelMessages(channelId, callback) {
    if (channelId in this.channelMessageSubscribers) {
      throw new Error(`Already subscribed to channel ${channelId}`);
    }
    this.channelMessageSubscribers[channelId] = callback;
  }

  unsubscribeFromChannelMessages(channelId) {
    delete this.channelMessageSubscribers[channelId];
    if (Object.keys(this.channelMessageSubscribers).length === 0) this.disconnect();
  }

  async request(...args) {
    const result = await this.client.call(...args)
      .catch(async error => {
        const errorMessage = error.error_message || error.message || `${error}`;
        if (errorMessage.includes('_MIGRATE_')) {
          const [_, nextDcId] = errorMessage.split('_MIGRATE_'); //eslint-disable-line
          this.client.setDefaultDc(Number(nextDcId));
          return await this.request(...args);
        }
        if (errorMessage === 'AUTH_RESTART') {
          return await this.request(...args);
        }
        if (errorMessage.includes('FLOOD_WAIT')) {
          const seconds = errorMessage.split('_WAIT_')[1];
          await delay((seconds * 1000) + 1);
          return await this.request(...args);
        }
        throw new Error(errorMessage);
      });

    // this is a simple fix to stop telegram from throwing flood errors, this wont work if requests are done in parralel
    await delay(50);
    return result;
  }

  async checkIfLoggedIn(){
    return await this.request('account.getAccountTTL', {});
  }

  async startLogin({mobile}){
    const { phone_code_hash } = await this.request(
      'auth.sendCode',
      {
        phone_number: mobile,
        settings: {
          _: 'codeSettings',
        }
      },
    );
    return { phoneCodeHash: phone_code_hash };
  }

  async completeLogin({ mobile, phoneCode, phoneCodeHash }) {
    const response = await this.request(
      'auth.signIn',
      {
        phone_code: phoneCode,
        phone_number: mobile,
        phone_code_hash: phoneCodeHash,
      },
    );

    if (response._ === 'auth.authorizationSignUpRequired') {
      const signUpRequiredMessage = `
        There is no Telegram account associated with ${mobile}.
        Please download the Telegram app on your mobile device and sign up, then try again.
      `;
      throw new Error(signUpRequiredMessage);
    }
  }

  async loadMessagesFromChannel({ channelId, accessHash, earliestMessageId, limit }) {
    const { messages, users } = await this.request(
      'messages.getHistory',
      {
        peer: {
          _: 'inputPeerChannel',
          channel_id: channelId,
          access_hash: accessHash,
        },
        offset_id: earliestMessageId,
        limit,
      },
    );

    return addUsersToMessages({
      users,
      messages: messages.filter(message => message._ === 'message' && message.message),
    });
  }

  async sendMessageToChannel({ message, channelId, accessHash }) {
    const { updates, users } = await this.request(
      'messages.sendMessage',
      {
        peer: {
          _: 'inputPeerChannel',
          channel_id: channelId,
          access_hash: accessHash,
        },
        message,
        random_id: Math.floor(Math.random() * 10000000000000000000),
      },
    );
    return getFormedMessagesFromUpdates({ updates, users, channelId });
  }

  async createChannel({ title, about }) {
    const createChannelResponse = await this.request(
      'channels.createChannel',
      {
        flags: 2,
        title,
        about,
      }
    );

    const { chats } = createChannelResponse;
    const chat = chats.find(chat => chat.title === title);
    return {
      channelId: chat.id,
      accessHash: chat.access_hash,
    };
  }

  async deleteChannel({ channelId, accessHash }) {
    await this.request(
      'channels.deleteChannel',
      {
        channel: {
          _: 'inputChannel',
          channel_id: channelId,
          access_hash: accessHash,
        }
      }
    );
  }

  async getChanneInviteHash({ channelId, accessHash }) {
    const { link } = await this.request(
      'messages.exportChatInvite',
      {
        peer: {
          _: 'inputPeerChannel',
          channel_id: channelId,
          access_hash: accessHash,
        }
      }
    );

    return { inviteHash: link.match(/joinchat\/(.+$)/)[1] };
  }

  async joinChannel({ inviteHash }) {
    const { chats } = await this.request(
      'messages.importChatInvite',
      { hash: inviteHash }
    );

    return { accessHash: chats[0].access_hash };
  }

  async leaveChannel({ channelId, accessHash }) {
    await this.request(
      'channels.leaveChannel',
      {
        channel: {
          _: 'inputChannel',
          channel_id: channelId,
          access_hash: accessHash,
        }
      }
    );
  }
};
