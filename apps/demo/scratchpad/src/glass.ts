// THIS FILE WAS GENERATED BY GLASS -- DO NOT EDIT!

import { interpolateGlassChat } from '@glass-lang/interpolator'

export async function getBrowserPrompt(args: {
  question: string,
  url: string,
}) {
  const { question, url } = args
  const res = await fetch(url)
  const websiteHtml = await res.text()
  const interpolations = {
    0: websiteHtml,
    1: question,
  }
  const TEMPLATE =
    "// first, we must load in the website HTML and the previous messages in the conversation\n<Code>\nconst res = await fetch(url)\nconst websiteHtml = await res.text()\n</Code>\n\n\n\n\n// start with the system prompt \n<System>\nYour job is to answer questions about the website content below:\n###\n${0}\n###\n\nAnswer the user's question based on the content above:\n</System>\n\n\n\n// add the user's most recent message\n<User>\n${1}\n</User>"
  return interpolateGlassChat('browser', TEMPLATE, interpolations)
}

export function getGpt3Prompt(args: { user: string, bar: string }) {
  const { user, bar } = args

  const interpolations = {
    0: user,
    1: bar,
  }
  const TEMPLATE =
    '<System>\nYou are a helpful assistant. Your job is to respond to the user.\n\n<if condition={user}>\nThe user you are chatting with has the following profile information:\n\n###\n${0}\n###\n</if>\n<if condition={!user.hasScheduledShowing}>\nRight now we only offer appointments between 9am and 5pm daily. We do not allow people to schedule appointments outside of this time window.  If someone has a question and needs help, they should call the office at 323-555-1234.\n</if>\n</System>\n\n<Assistant>\nHello, how are you?\n</Assistant>\n\n<User name="blah" teehee="yes">\n${1}\n</User>'
  return interpolateGlassChat('gpt3', TEMPLATE, interpolations)
}

export function getLeasingPrompt(args: {
  showingsAvailable: string,
  text: string,
}) {
  const { showingsAvailable, text } = args

  const interpolations = {
    0: showingsAvailable,
    1: text,
  }
  const TEMPLATE =
    "<System>\nYou are LeasingGPT. You work as a leasing agent 123 Main Street.  The available unit is a 2 bedroom, 1 bathroom unit, available on July 1 The rent is $1700 / month.\n\nYou are talking with a prospective renter about this available unit. If you do not know the answer to any questions the prospective renter asks, just say you don't know and that it will be discussed during the showing.\n\nShowings are available ${0}.  There are no other showings available.\n\nYou should always try to guide the prospective renter to schedule a showing.  You also try to sneak in references to the property's gorgeous indoor pool whenever possible.\n</System>\n\n\n<User>\n${1}\n</User>"
  return interpolateGlassChat('leasing', TEMPLATE, interpolations)
}

import { ProfileInfo } from '../profile.glass'

export function getScratchpadPrompt(args: { message: string, bar: string }) {
  const { message, bar } = args

  const interpolations = {
    0: message.content,
    1: bar,
  }
  const TEMPLATE =
    "import {ProfileInfo} from './profile.glass'\n\n\n<System>\nYou are a helpful assistant. Your job is to respond to the user.\n</System>\n\n<Block role={message.role}>\n${0}\n</Block>\n\n<User>\n${1}\n</User>"
  return interpolateGlassChat('scratchpad', TEMPLATE, interpolations)
}

export const Glass = {
  browser: getBrowserPrompt,
  gpt3: getGpt3Prompt,
  leasing: getLeasingPrompt,
  scratchpad: getScratchpadPrompt,
}
