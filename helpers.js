'use strict';

const { AUTH_KEYS_KEYS } = require('@mtproto/core');

function extractMessagesFromUpdates({updates, channelId}) {
  const messages = [];
  updates
    // TODO handle update and delete messages
    .filter(update => update._ === 'updateNewChannelMessage' && update.message.message)
    .forEach(({message}) => {
      if (channelId && +message.to_id.channel_id === +channelId) messages.push(message);
      else if (!channelId) messages.push(message);
    });
  return messages;
}

function addUsersToMessages({ users, messages }) {
  const usersById = {};
  users.forEach(user => {
    usersById[user.id] = {
      firstName: user.first_name,
      phone: user.phone,
    };
  });

  const messagesWithUser = {};
  messages.forEach(message => {
    messagesWithUser[message.id] = {
      id: message.id,
      date: message.date,
      user: usersById[message.from_id],
      message: message.message,
      channelId: message.to_id.channel_id,
    };
  });

  return messagesWithUser;
}

function getFormedMessagesFromUpdates({updates, channelId, users}) {
  const messages = extractMessagesFromUpdates({ updates, channelId });
  return addUsersToMessages({ users, messages });
}

module.exports = {
  addUsersToMessages,
  getFormedMessagesFromUpdates,
  AUTH_KEYS_KEYS,
};
