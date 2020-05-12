'use strict';

const { MTProto } = require('@mtproto/core');
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
    if (this.client) return;

    return new Promise((resolve, reject) => {
      this.client = new MTProto({
        api_id: this.apiID,
        api_hash: this.apiHash,
        test: this.test,
        authKeys,
      });

      const socket = Object.values(this.client.rpcs)[0].transport.socket;

      const onOpen = () => {
        this.client.updates.on('updates', ({ updates, users }) => {
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

        resolve();
      };

      const onError = (error) => {
        reject(error);
      };

      // Node socket users different methods than browser socket
      if (socket.on) {
        socket.on('connect', onOpen);
        socket.on('error', onError);
      } else {
        socket.onopen = onOpen;
        socket.onerror = onError;
      }
    });
  }

  disconnect() {
    if (!this.client) return;

    Object.values(this.client.rpcs).forEach(({ transport }) => {
      transport.destroy();
    });
    delete this.client;
  }

  importAuthKeys(authKeys) {
    this.client.importAuthKeys(authKeys);
  }

  getAuthKeys() {
    return this.client.getAuthKeys();
  }

  subscribeToChannelMessages(channelId, callback) {
    this.channelMessageSubscribers[channelId] = callback;
  }

  unsubscribeFromChannelMessage(channelId) {
    delete this.channelMessageSubscribers[channelId];
  }

  async request(...args) {
    return await this.client
      .call(...args)
      .catch(async error => {
        if (error.error_message.includes('_MIGRATE_')) {
          const [_, nextDcId] = error.error_message.split('_MIGRATE_'); //eslint-disable-line
          this.client.setDefaultDc(Number(nextDcId));
          return await this.request(...args);
        }
        if (error.error_message === 'AUTH_RESTART') {
          return await this.request(...args);
        }
        if (error.error_message.includes('FLOOD_WAIT')) {
          const seconds = error.error_message.split('_WAIT_')[1];
          throw new Error(`Our servers busy talking to Telegram. Please try again in ${seconds} seconds`);
        }
        throw new Error(error.error_message);
      });
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
    return response;
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
    const { chats } = await this.request(
      'channels.createChannel',
      {
        flags: 2,
        title,
        about,
      }
    );

    const chat = chats.find(chat => chat.title === title);
    return {
      channelId: chat.id,
      accessHash: chat.access_hash,
    };
  }

  async deleteChannel({ channelId, accessHash }) {
    return await this.request(
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
