/**
 * Static reference data for email/domain classification. Kept in code (not a
 * remote feed) so lookups are free, offline and deterministic.
 */

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

/** Throwaway / temporary inbox providers. */
export const DISPOSABLE_DOMAINS = set(`
 0-mail.com 0815.ru 0clickemail.com 10mail.org 10minutemail.co.uk 10minutemail.com 10minutemail.net 10minutemail.de
 10minutesmail.com 20minutemail.com 20minutemail.it 2prong.com 30minutemail.com 33mail.com 4warding.com
 6paq.com 7tags.com 99experts.com anonbox.net anonymbox.com antichef.com antispam.de armyspy.com baxomale.ht.cx
 beefmilk.com binkmail.com bobmail.info boximail.com brefmail.com bugmenot.com bumpymail.com
 burnermail.io byom.de chammy.info cool.fr.nf courriel.fr.nf courrieltemporaire.com
 cuvox.de dandikmail.com dayrep.com deadaddress.com despam.it despammed.com devnullmail.com dfgh.net
 discard.email discardmail.com discardmail.de disposableaddress.com disposableemailaddresses.com
 disposableinbox.com dispose.it disposeamail.com dispostable.com dodgeit.com dodgit.com donemail.ru dontreg.com
 dontsendmespam.de drdrb.com dropmail.me dump-email.info dumpandjunk.com dumpmail.de dumpyemail.com e4ward.com
 easytrashmail.com einrot.com email60.com emailondeck.com emailfake.com emailias.com emailinfive.com emailmiser.com
 emailsensei.com emailtemporanea.net emailtemporario.com.br emailthe.net emailtmp.com emailwarden.com emailx.at.hm
 emailxfer.com ephemail.net explodemail.com eyepaste.com
 fakeinbox.com fakeinformation.com fakemail.fr fakemailgenerator.com fakemailz.com 
 fightallspam.com filzmail.com fizmail.com fleckens.hu flyspam.com frapmail.com 
 get1mail.com get2mail.fr getairmail.com getmails.eu getnada.com
 getonemail.com ghosttexter.de gishpuppy.com greensloth.com
 guerillamail.biz guerillamail.com guerillamail.de guerillamail.net guerillamail.org guerrillamail.biz guerrillamail.com
 guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org guerrillamailblock.com gustr.com h8s.org
 haltospam.com harakirimail.com hatespam.org herp.in hidemail.de hidzz.com hmamail.com hopemail.biz
 hotpop.com hulapla.de ieatspam.eu ieatspam.info ihateyoualot.info imails.info inbax.tk inbox.si inboxalias.com
 inboxbear.com inboxclean.com inboxclean.org inboxkitten.com incognitomail.com incognitomail.net incognitomail.org
 insorg-mail.info ipoo.org jetable.com jetable.fr.nf jetable.net jetable.org jnxjn.com jourrapide.com
 junk1e.com kasmail.com kaspop.com keepmymail.com killmail.com killmail.net klzlk.com koszmail.pl
 kurzepost.de lawlita.com letthemeatspam.com lhsdv.com link2mail.net litedrop.com 
 lopl.co.cc lortemail.dk lovemeleaveme.com lr78.com maboard.com mail-temporaire.fr mail.tm
 mail1a.de mail21.cc mail2rss.org mail333.com mail4trash.com mailbidon.com mailblocks.com mailcatch.com maildrop.cc
 maildx.com maileater.com mailexpire.com mailfa.tk mailforspam.com mailfreeonline.com mailguard.me mailimate.com
 mailin8r.com mailinater.com mailinator.com mailinator.net mailinator.org mailinator2.com mailincubator.com mailismagic.com
 mailme.lv mailme24.com mailmetrash.com mailmoat.com mailnator.com mailnesia.com mailnull.com mailpick.biz
 mailrock.biz mailsac.com mailscrap.com mailshell.com mailsiphon.com mailtemp.info mailtome.de mailtothis.com mailtrash.net
 mailtv.net mailzilla.com mailzilla.org makemetheking.com mbx.cc mega.zik.dj meinspamschutz.de meltmail.com
 messagebeamer.de mierdamail.com mintemail.com moakt.com mohmal.com moncourrier.fr.nf monemail.fr.nf
 monmail.fr.nf mycleaninbox.net mymail-in.net myphantomemail.com
 mytemp.email mytempemail.com mytrashmail.com neomailbox.com nepwk.com
 nervmich.net nervtmich.net netmails.com netmails.net neverbox.com no-spam.ws nobulk.com noclickemail.com nogmailspam.info
 nomail.xl.cx nomail2me.com nomorespamemails.com nospam.ze.tc nospam4.us nospamfor.us nospammail.net notmailinator.com
 nowmymail.com nurfuerspam.de nwldx.com odnorazovoe.ru oneoffemail.com
 onewaymail.com opayq.com otherinbox.com owlpic.com pjjkp.com
 pokemail.net pookmail.com proxymail.eu prtnx.com
 putthisinyourspamdatabase.com quickinbox.com rcpt.at recursor.net regbypass.com rejectmail.com
 rhyta.com rklips.com rmqkr.net rppkn.com rtrtr.com safe-mail.net safersignup.de safetymail.info safetypost.de
 saynotospams.com schafmail.de schrott-email.de secretemail.de secure-mail.biz selfdestructingmail.com
 sendspamhere.com sharklasers.com shieldedmail.com shiftmail.com shitmail.me shortmail.net sibmail.com skeefmail.com
 slaskpost.se slopsbox.com smashmail.de smellfear.com snakemail.com sneakemail.com sofimail.com sofort-mail.de sogetthis.com
 soodonims.com spam.la spam.su spam4.me spamail.de spambob.com spambob.net spambob.org spambog.com spambog.de spambog.ru
 spambox.info spambox.us spamcannon.com spamcannon.net spamcero.com spamcon.org spamcorptastic.com spamcowboy.com
 spamday.com spamex.com spamfree24.com spamfree24.de spamfree24.eu spamfree24.info spamfree24.net spamfree24.org
 spamgourmet.com spamgourmet.net spamgourmet.org spamherelots.com spamhereplease.com spamhole.com spamify.com spaminator.de
 spamkill.info spaml.com spaml.de spammotel.com spamobox.com spamoff.de spamslicer.com spamspot.com spamthis.co.uk
 spamthisplease.com spamtrail.com speed.1s.fr supermailer.jp superrito.com suremail.info
 teleworm.com teleworm.us temp-mail.io temp-mail.org temp-mail.ru tempail.com tempalias.com
 tempe-mail.com tempemail.biz tempemail.co.za tempemail.com tempemail.net tempinbox.co.uk tempinbox.com tempmail.co
 tempmail.de tempmail.it tempmail.net tempmail.plus tempmail2.com tempmaildemo.com tempmailer.com tempmailer.de
 tempomail.fr temporarily.de temporarioemail.com.br temporaryemail.net temporaryemail.us temporaryforwarding.com
 temporaryinbox.com temporarymailaddress.com tempr.email tempthe.net thanksnospam.info thisisnotmyrealemail.com
 throam.com throwam.com throwawayemailaddress.com throwawaymail.com tilien.com tittbit.in tmail.ws tmailinator.com
 toiea.com tradermail.info trash-amil.com trash-mail.at trash-mail.com trash-mail.de trash2009.com trashdevil.com
 trashdevil.de trashemail.de trashmail.at trashmail.com trashmail.de trashmail.me trashmail.net trashmail.org trashmail.ws
 trashmailer.com trashymail.com trashymail.net trbvm.com trialmail.de turual.com twinmail.de tyldd.com
 uplipht.com veryrealemail.com viditag.com 
 vomoto.com vubby.com wasteland.rfc822.org webemail.me weg-werf-email.de
 wegwerf-email.de wegwerfadresse.de wegwerfemail.com wegwerfemail.de wegwerfmail.de wegwerfmail.info wegwerfmail.net
 wegwerfmail.org wh4f.org whyspam.me willselfdestruct.com wuzup.net
 wuzupmail.net wwwnew.eu xmaily.com 
 yopmail.com yopmail.fr yopmail.net yuurok.com zehnminuten.de
 zehnminutenmail.de zetmail.com zippymail.info zoaxe.com zomg.info
`);

/** MX host suffixes operated by disposable-mail services (catches rotating domains). */
export const DISPOSABLE_MX_SUFFIXES = [
 'mailinator.com',
 'guerrillamail.com',
 'yopmail.com',
 'temp-mail.org',
 'mail.tm',
 'dropmail.me',
 'emailondeck.com',
 'mailsac.com',
 'harakirimail.com',
 'trashmail.com',
 'getnada.com',
 'maildrop.cc',
];

export const DISPOSABLE_PATTERNS: readonly RegExp[] = [
 /(^|[.-])(temp|tmp|throw-?away|disposable|trash|fake|burner|junk|spam)[-]?(e?mail|inbox|box|addr)/,
 /^\d{1,2}-?minute-?s?-?mail\./,
 /mailinator|guerrill?amail|yopmail|sharklasers/,
];

/** Consumer mailbox providers — fine for B2C, a weak signal for B2B leads. */
export const FREE_PROVIDERS = set(`
 gmail.com googlemail.com yahoo.com yahoo.co.uk yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.ca yahoo.com.au yahoo.co.in
 yahoo.co.jp yahoo.com.br yahoo.com.mx ymail.com rocketmail.com outlook.com outlook.de outlook.fr outlook.es outlook.it
 hotmail.com hotmail.co.uk hotmail.fr hotmail.de hotmail.es hotmail.it hotmail.nl hotmail.be live.com live.co.uk live.fr
 live.de live.nl live.it live.com.au msn.com passport.com icloud.com me.com mac.com aol.com aol.co.uk aim.com
 protonmail.com protonmail.ch proton.me pm.me gmx.com gmx.de gmx.net gmx.at gmx.ch gmx.fr web.de t-online.de freenet.de
 posteo.de posteo.net mailbox.org mail.ru inbox.ru list.ru bk.ru yandex.ru yandex.com yandex.ua ya.ru rambler.ru
 qq.com 163.com 126.com yeah.net sina.com sina.cn sohu.com aliyun.com foxmail.com naver.com daum.net hanmail.net
 zoho.com zohomail.com zohomail.eu fastmail.com fastmail.fm hey.com tutanota.com tutanota.de tuta.io tutamail.com
 mail.com email.com usa.com post.com consultant.com orange.fr wanadoo.fr free.fr laposte.net sfr.fr neuf.fr libero.it
 virgilio.it alice.it tiscali.it tin.it seznam.cz centrum.cz email.cz wp.pl o2.pl onet.pl interia.pl op.pl
 rediffmail.com uol.com.br bol.com.br terra.com.br ig.com.br comcast.net verizon.net att.net sbcglobal.net bellsouth.net
 cox.net charter.net earthlink.net optonline.net btinternet.com sky.com virginmedia.com ntlworld.com talktalk.net
 blueyonder.co.uk bigpond.com bigpond.net.au optusnet.com.au shaw.ca rogers.com sympatico.ca videotron.ca telus.net
 xs4all.nl ziggo.nl kpnmail.nl planet.nl home.nl telenet.be skynet.be bluewin.ch sunrise.ch hispeed.ch a1.net chello.at
 telia.com spray.se bredband.net online.no frisurf.no suomi24.fi luukku.com sapo.pt netcabo.pt abv.bg mail.bg
 inbox.lv inbox.lt mail.ee hot.ee azet.sk centrum.sk freemail.hu citromail.hu yahoo.gr windowslive.com hushmail.com
 runbox.com mailfence.com startmail.com skiff.com duck.com
`);

/** Shared/role mailboxes: deliverable, but not a named person. */
export const ROLE_LOCAL_PARTS = set(`
 admin administrator info information sales support contact contactus hello hi office billing accounts accounting
 finance invoices invoice ap ar hr jobs careers recruiting marketing noreply no-reply donotreply do-not-reply postmaster
 webmaster hostmaster abuse security team help helpdesk service services enquiries enquiry inquiries inquiry press media
 legal privacy compliance tax vat orders order purchasing procurement shop store mail email newsletter news partners
`);

/** MX host suffix → mailbox provider. First match wins. */
export const MAIL_PROVIDERS: readonly [string, string][] = [
 ['google.com', 'Google Workspace'],
 ['googlemail.com', 'Google Workspace'],
 ['mail.protection.outlook.com', 'Microsoft 365'],
 ['outlook.com', 'Microsoft 365'],
 ['hotmail.com', 'Microsoft (consumer)'],
 ['zoho.com', 'Zoho Mail'],
 ['zoho.eu', 'Zoho Mail'],
 ['zohomail.com', 'Zoho Mail'],
 ['pphosted.com', 'Proofpoint'],
 ['ppe-hosted.com', 'Proofpoint Essentials'],
 ['mimecast.com', 'Mimecast'],
 ['mimecast-offshore.com', 'Mimecast'],
 ['barracudanetworks.com', 'Barracuda'],
 ['iphmx.com', 'Cisco Secure Email'],
 ['messagelabs.com', 'Broadcom Email Security'],
 ['trendmicro.com', 'Trend Micro'],
 ['trendmicro.eu', 'Trend Micro'],
 ['amazonaws.com', 'Amazon SES'],
 ['protonmail.ch', 'Proton Mail'],
 ['messagingengine.com', 'Fastmail'],
 ['yandex.net', 'Yandex 360'],
 ['yandex.ru', 'Yandex 360'],
 ['mail.ru', 'VK WorkMail'],
 ['qq.com', 'Tencent Exmail'],
 ['icloud.com', 'iCloud Mail'],
 ['yahoodns.net', 'Yahoo Mail'],
 ['secureserver.net', 'GoDaddy'],
 ['ovh.net', 'OVHcloud'],
 ['kundenserver.de', 'IONOS'],
 ['ionos.com', 'IONOS'],
 ['one.com', 'one.com'],
 ['hostinger.com', 'Hostinger'],
 ['titan.email', 'Titan'],
 ['mailgun.org', 'Mailgun'],
 ['sendgrid.net', 'SendGrid'],
 ['mailinator.com', 'Mailinator (disposable)'],
 ['yopmail.com', 'YOPmail (disposable)'],
 ['guerrillamail.com', 'Guerrilla Mail (disposable)'],
];
